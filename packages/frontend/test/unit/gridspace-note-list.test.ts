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
const auth = vi.hoisted(() => ({ user: { id: 'viewer', hardMutedWords: [] } as { id: string; hardMutedWords: [] } | null }));
vi.mock('@/i.js', () => ({ get $i() { return auth.user; } }));
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
	auth.user = { id: 'viewer', hardMutedWords: [] };
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
	it('recovers automatically when the grant status initially reports a peer outage', async () => {
		let available = false;
		respond = async endpoint => endpoint === 'gridspace/private-grant' ? { available, granted: true } : page([privateNote(5)]);
		const { list } = mount({ kind: 'antenna', antennaId: 'antenna' }); await settle();
		expect(list.privateError.value).toBe(true); expect(list.rows.value).toHaveLength(0);
		available = true; await vi.advanceTimersByTimeAsync(15000); await settle();
		expect(list.privateError.value).toBe(false); expect(list.rows.value[0].note.id).toBe('p5');
	});
	it('keeps antenna row positions and the older cursor through a transient validation failure, then recovers automatically', async () => {
		let offline = false;
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (offline) throw new Error('temporary timeout');
			if (params.mode === 'validate') return page([privateNote(5)]);
			return params.cursor ? page([privateNote(1)]) : page([privateNote(5)], 'older', 3);
		};
		const { list } = mount({ kind: 'antenna', antennaId: 'antenna' }); await settle();
		offline = true; await vi.advanceTimersByTimeAsync(15000); await settle();
		expect(list.privateError.value).toBe(true);
		expect(list.rows.value).toHaveLength(1); expect(list.rows.value[0].note).not.toHaveProperty('text');
		offline = false; await vi.advanceTimersByTimeAsync(15000); await settle();
		expect(list.privateError.value).toBe(false); expect(list.rows.value[0].note).toHaveProperty('text', 'p5');
		await list.load(); expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'older' });
	});
	it.each([false, true])('merges old-account mentions with local mentions (direct=%s) and revalidates the same scope', async direct => {
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'notes/mentions') return [normal(4)];
			return page([privateNote(5)]);
		};
		const { list } = mount({ kind: 'mentions', direct }); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['p5', 'n4']);
		expect(api.mock.calls.find(([endpoint]) => endpoint === 'notes/mentions')?.[1]).toMatchObject({ visibility: direct ? 'specified' : undefined });
		expect(api.mock.calls.find(([endpoint]) => endpoint === 'gridspace/private-notes')?.[1]).toMatchObject({ mode: direct ? 'direct' : 'mentions' });
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		expect(list.rows.value[0].note).not.toHaveProperty('text');
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'validate', contextMode: direct ? 'direct' : 'mentions', ids: ['p5'] });
	});
	it('allows anonymous ordinary profile pagination after hiding and returning', async () => {
		auth.user = null;
		respond = async (_endpoint, params) => params.untilId ? [normal(1)] : Array.from({ length: 20 }, (_, index) => normal(30 - index));
		const { list } = mount({ kind: 'profile', userId: 'author', linked: false, withReplies: false, withRenotes: false, withFiles: false, withChannelNotes: false });
		await settle();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
		await list.load();
		expect(list.rows.value).toHaveLength(21);
		expect(api.mock.calls.every(([endpoint]) => endpoint === 'users/notes')).toBe(true);
	});
	it('retains the private cursor after revalidation and keeps normal pagination after revocation', async () => {
		let revoked = false;
		respond = async (endpoint, params) => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/search') return params.cursor ? searchPage([normal(1)]) : searchPage([normal(9), normal(4)], 'normal-next');
			if (params.mode === 'validate') { if (revoked) throw { info: { reason: 'AUTHORIZATION_REVOKED' } }; return page([privateNote(8), privateNote(2)]); }
			return params.cursor ? page([privateNote(1)]) : page([privateNote(8), privateNote(2)], 'private-next', 6);
		};
		const { list } = mount(); await settle();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
		await list.load();
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'private-next' });
		revoked = true; window.dispatchEvent(new Event('focus')); await settle();
		expect(list.privateError.value).toBe(true);
		hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
		await list.load();
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'normal-next' });
		expect(list.rows.value.every(row => row.kind === 'normal')).toBe(true);
	});
	it('keeps ordinary rows through a granted background check while private notes are loading', async () => {
		let delay = false; let release!: (value: unknown) => void;
		respond = async endpoint => {
			if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
			if (endpoint === 'gridspace/search') return searchPage([normal(4)]);
			return delay ? new Promise(resolve => { release = resolve; }) : page([privateNote(5)]);
		};
		const { list } = mount(); await settle();
		const original = list.rows.value.find(row => row.kind === 'normal')!.note;
		delay = true;
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['p5', 'n4']);
		expect(list.rows.value[0].note).toEqual({ id: 'p5', uri: 'https://peer/notes/p5', createdAt: at(5), suspended: true, visible: true });
		expect(list.rows.value[1].note).toBe(original);
		release(page([privateNote(5)])); await settle();
		expect(list.rows.value.map(row => row.note.id)).toEqual(['p5', 'n4']);
		expect(list.rows.value[1].note).toBe(original);
	});
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
			if (params.mode === 'validate') { expect(params).toMatchObject({ contextMode: 'search', query: 'query', ids: ['p8', 'p1'] }); if (revoked) throw { info: { reason: 'AUTHORIZATION_REVOKED' } }; }
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
	it('preserves ordinary rows while a focus or visibility consent check is pending', async () => {
		let delay = false; let release!: (value: unknown) => void;
		respond = async endpoint => endpoint === 'gridspace/private-grant'
			? delay ? new Promise(resolve => { release = resolve; }) : { available: true, granted: false }
			: searchPage([normal(4)]);
		const { list } = mount(); await settle();
		const original = list.rows.value[0].note;
		delay = true; window.dispatchEvent(new Event('focus')); await settle();
		expect(list.rows.value[0].note).toBe(original);
		release({ available: true, granted: false }); await settle();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(list.rows.value[0].note).toBe(original);
		release({ available: true, granted: false }); await settle();
		expect(list.rows.value[0].note).toBe(original);
	});

});

it('sorts linked clip pages oldest first and keeps filters on validation', async () => {
 respond = async (endpoint, params) => {
  if (endpoint === 'gridspace/collections') return { enabled: true, clips: true };
  if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
  if (params.mode === 'validate') return page([privateNote(1), privateNote(2), privateNote(3)]);
  return params.cursor ? page([privateNote(3)]) : page([privateNote(1), privateNote(2)], 'next', 2);
 };
 const { list, source } = mount({ kind: 'clip', clipId: 'clip', order: 'oldest', query: 'needle', rangeStartAt: 123 }); await settle();
 expect(list.rows.value.map(row => row.note.id)).toEqual(['p1', 'p2']);
 expect(api.mock.calls.find(([endpoint]) => endpoint === 'gridspace/private-notes')?.[1]).toMatchObject({ mode: 'clip', clipId: 'clip', order: 'oldest', query: 'needle', rangeStartAt: 123 });
 await list.load(); expect(list.rows.value.map(row => row.note.id)).toEqual(['p1', 'p2', 'p3']);
 expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'next', order: 'oldest' });
 window.dispatchEvent(new Event('focus')); await settle();
 expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'validate', contextMode: 'clip', order: 'oldest', query: 'needle' });
 source.value = { kind: 'clip', clipId: 'clip', order: 'newest', query: 'other' }; await settle();
 expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'clip', order: 'newest', query: 'other', cursor: undefined });
});
