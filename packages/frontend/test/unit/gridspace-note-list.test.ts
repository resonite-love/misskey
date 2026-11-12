/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, nextTick, ref } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useGridspaceNoteList } from '@/utility/use-gridspace-note-list.js';
import type { GridspaceNoteSource } from '@/utility/use-gridspace-note-list.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/composables/use-note.js', () => ({ checkNoteWordMute: () => false }));
const api = vi.mocked(misskeyApi);
const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const normal = (n: number, id = `n${n}`, extra = {}) => ({ id, createdAt: at(n), text: id, ...extra });
const privateNote = (n: number, id = `p${n}`) => ({ id, uri: `https://peer/notes/${id}`, createdAt: at(n), text: id, files: [] });
const page = (notes: unknown[] = [], cursor: string | null = null, boundary = 0) => ({ notes, cursor, scannedThrough: boundary ? at(boundary) : null, observedAt: at(100) });
const searchPage = (notes: unknown[] = [], cursor: string | null = null, available = true) => ({ notes, cursor, peerAvailable: available });
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await nextTick(); };
let cleanup = () => {};
let respond: (endpoint: string, params: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
	vi.useFakeTimers(); api.mockReset();
	api.mockImplementation(((endpoint, params) => respond(endpoint, params ?? {})) as typeof misskeyApi);
});
afterEach(() => { cleanup(); cleanup = () => {}; vi.restoreAllMocks(); vi.useRealTimers(); });

function mount(sourceValue: GridspaceNoteSource = { kind: 'search', query: 'query' }) {
	const source = ref(sourceValue);
	let list!: ReturnType<typeof useGridspaceNoteList>;
	const app = createApp({ setup() { list = useGridspaceNoteList(computed(() => source.value)); return () => null; } });
	app.mount(document.createElement('div')); cleanup = () => app.unmount();
	return { list, source };
}

describe('one profile/search note list', () => {
	it('waits for both sources, sorts pages and holds equal-time boundaries', async () => {
		let release!: (value: unknown) => void;
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/search') return params.cursor ? searchPage([normal(5, 'n5b'), normal(1)]) : searchPage([normal(9), normal(5)], 'normal-next');
			return params.cursor ? page([privateNote(5, 'p5b'), privateNote(2)]) : new Promise(resolve => { release = resolve; });
		};
		const { list } = mount(); await settle();
		expect(list.rows.value).toHaveLength(0); expect(list.loading.value).toBe(true);
		release(page([privateNote(8), privateNote(5)], 'private-next', 5)); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['n9', 'p8']);
		await list.load();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['n9', 'p8', 'n5', 'n5b', 'p5', 'p5b', 'p2', 'n1']);
		expect(list.hasMore.value).toBe(false);
	});
	it('continues empty filtered pages and deduplicates by URI with private fallback for hidden shells', async () => {
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/search') return searchPage([normal(8, 'local-p8', { uri: 'https://peer/notes/p8' }), normal(7, 'hidden-p7', { uri: 'https://peer/notes/p7', isHidden: true })]);
			return params.cursor ? page([privateNote(8), privateNote(7)]) : page([], 'filtered', 9);
		};
		const { list } = mount(); await settle();
		expect(list.rows.value).toHaveLength(0);
		await list.load();
		expect(list.rows.value.map(row => [row.kind, row.note.id])).toEqual([['normal', 'local-p8'], ['private', 'p7']]);
	});
	it('uses ordinary profile pagination when no old-account consent exists', async () => {
		respond = async endpoint => endpoint === 'gridspace/private-grant' ? { available: false, granted: false } : [normal(4)];
		const { list } = mount({ kind: 'profile', userId: 'author', linked: false, withReplies: false, withRenotes: false, withFiles: true, withChannelNotes: false });
		await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['n4']);
		expect(list.privateError.value).toBe(false);
		expect(api.mock.calls.find(([endpoint]) => endpoint === 'users/notes')?.[1]).toMatchObject({ userId: 'author', withFiles: true, withReplies: false });
		expect(api.mock.calls.some(([endpoint]) => endpoint === 'gridspace/private-notes')).toBe(false);
	});
	it('changes filters and ignores delayed results from the previous profile', async () => {
		const delayed: ((value: unknown) => void)[] = [];
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (params.userId === 'old') return new Promise(resolve => delayed.push(resolve));
			return endpoint === 'gridspace/history' ? page([normal(3)]) : page([privateNote(2)]);
		};
		const { list, source } = mount({ kind: 'profile', userId: 'old', linked: true, withReplies: true, withRenotes: true, withFiles: false, withChannelNotes: true });
		await settle();
		source.value = { ...source.value, userId: 'new', withFiles: true } as GridspaceNoteSource; await settle();
		for (const release of delayed) release(page([privateNote(99)])); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['n3', 'p2']);
		expect(api.mock.calls.filter(([, params]) => (params as { userId?: string }).userId === 'new').every(([, params]) => (params as { withFiles?: boolean }).withFiles)).toBe(true);
	});
	it('keeps private-only results through a normal outage and replaces partial previews on retry', async () => {
		let online = false;
		respond = async endpoint => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/private-notes') return page([privateNote(4)]);
			return online ? searchPage([normal(6)]) : searchPage([normal(2, 'preview')], null, false);
		};
		const { list } = mount(); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['p4', 'preview']);
		expect(list.normalError.value).toBe('PEER_UNAVAILABLE');
		online = true; await list.retry();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['n6', 'p4']);
	});
	it('revalidates retained hidden-page bodies with the same search and clears them on revocation', async () => {
		let revoked = false;
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/search') return searchPage([normal(7), normal(5)], 'more');
			if (params.mode === 'validate') { expect(params).toMatchObject({ contextMode: 'search', query: 'query', ids: ['p8', 'p1'] }); if (revoked) throw new Error('revoked'); }
			return page([privateNote(8), privateNote(1)]);
		};
		const { list } = mount(); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['p8', 'n7']);
		revoked = true; await vi.advanceTimersByTimeAsync(15000);
		expect(list.privateError.value).toBe(true);
		expect(list.rows.value.every(row => row.kind === 'normal')).toBe(true);
	});
	it('drops delegated bodies on hide and rejects late responses while keeping normal notes', async () => {
		let release!: (value: unknown) => void;
		respond = async endpoint => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/search') return searchPage([normal(4)]);
			return new Promise(resolve => { release = resolve; });
		};
		const { list } = mount(); await settle();
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		release(page([privateNote(9)])); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['n4']);
	});
});
