/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, nextTick, ref } from 'vue';
import { useGridspaceNoteList } from '@/utility/use-gridspace-note-list.js';
import type { GridspaceNoteSource } from '@/utility/use-gridspace-note-list.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { supportsTimelineKind } from '@/utility/timeline-capabilities.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/timeline-stream.js', () => ({ subscribeTimeline: vi.fn(() => () => {}) }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/composables/use-note.js', () => ({ checkNoteWordMute: () => false }));
const api = vi.mocked(misskeyApi);
const at = new Date(1700000000000).toISOString();
const item = { key: 'https://peer/notes/one', ref: 'signed-one', sortKey: { sortAt: '1700000000000000', uri: 'https://peer/notes/one' }, representation: 'delegated', validForMs: 10000, payload: { id: 'one', uri: 'https://peer/notes/one', createdAt: at, text: 'secret', files: [] } };
const page = { version: 1, session: 'session', revision: 'revision', items: [item], nextCursor: 'next', updatesCursor: 'updates', complete: true, mode: 'unified', sources: [{ source: 'peer', status: 'ok', retryable: false }], revalidateAfterMs: 10000 };
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); await nextTick(); };
let cleanup = () => {};

function mount(value: GridspaceNoteSource) {
	const source = ref(value);
	let list!: ReturnType<typeof useGridspaceNoteList>;
	const app = createApp({ setup() { list = useGridspaceNoteList(computed(() => source.value)); return () => null; } });
	app.mount(document.createElement('div')); cleanup = () => app.unmount();
	return { list, source };
}

beforeEach(() => { vi.useFakeTimers(); api.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('per-kind unified list dispatch', () => {
	it('requires an enabled version-one capability for the exact kind', () => {
		expect(supportsTimelineKind({ timeline: { version: 1, enabled: true, kinds: ['home'] } }, 'channel')).toBe(false);
		expect(supportsTimelineKind({ timeline: { version: 1, enabled: false, kinds: ['channel'] } }, 'channel')).toBe(false);
		expect(supportsTimelineKind({ timeline: { version: 2, enabled: true, kinds: ['channel'] } }, 'channel')).toBe(false);
		expect(supportsTimelineKind({ timeline: { version: 1, enabled: true, kinds: ['channel'] } }, 'channel')).toBe(true);
	});
	it('maps direct messages to the direct source and never starts a legacy request', async () => {
		api.mockImplementation((async endpoint => endpoint === 'gridspace/link' ? { timeline: { version: 1, enabled: true, kinds: ['direct'] } } : page) as typeof misskeyApi);
		const { list } = mount({ kind: 'mentions', direct: true }); await flush();
		expect(list.integrated.value).toBe(true);
		expect(list.rows.value[0]).toMatchObject({ kind: 'private', note: { text: 'secret' } });
		expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual(['gridspace/link', 'gridspace/timeline']);
		expect(api.mock.calls[1][1]).toMatchObject({ kind: 'direct' });
		await list.load();
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'next', kind: 'direct' });
	});
	it('keeps the hidden snapshot and revalidates without a legacy read on return', async () => {
		api.mockImplementation((async endpoint => endpoint === 'gridspace/link' ? { timeline: { version: 1, enabled: true, kinds: ['antenna'] } } : page) as typeof misskeyApi);
		const { list } = mount({ kind: 'antenna', antennaId: 'antenna' }); await flush();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		expect(list.rows.value[0]).toHaveProperty('note.text', 'secret');
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await flush();
		expect(api.mock.calls.at(-1)?.[0]).toBe('gridspace/timeline/changes');
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ refs: ['signed-one'] });
	});
	it('preserves consent checks and ascending clip options when capability is absent', async () => {
		api.mockImplementation((async endpoint => {
			if (endpoint === 'gridspace/link') return { timeline: { version: 1, enabled: true, kinds: ['home'] } };
			if (endpoint === 'gridspace/collections') return { enabled: true, clips: false };
			throw new Error('Unexpected endpoint');
		}) as typeof misskeyApi);
		const { list } = mount({ kind: 'clip', clipId: 'clip', order: 'oldest' }); await flush();
		expect(list.integrated.value).toBe(false);
		expect(list.needsAuthorization.value).toBe(true);
		expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual(['gridspace/link', 'gridspace/collections']);
	});
	it('does not fall back after a supported unified read fails', async () => {
		api.mockImplementation((async endpoint => {
			if (endpoint === 'gridspace/link') return { timeline: { version: 1, enabled: true, kinds: ['search'] } };
			throw new Error('Peer timeout');
		}) as typeof misskeyApi);
		const { list } = mount({ kind: 'search', query: 'query' }); await flush();
		expect(list.integrated.value).toBe(true); expect(list.privateError.value).toBe(true);
		expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual(['gridspace/link', 'gridspace/timeline']);
	});
});
