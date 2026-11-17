/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import PrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/timeline-stream.js', () => ({ subscribeTimeline: vi.fn(() => () => {}) }));
vi.mock('@/i.js', () => ({ $i: { id: 'channel-only', hardMutedWords: [] } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false, enablePullToRefresh: false, enableInfiniteScroll: true } } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { channel: 'Channel', noNotes: 'Empty', _gridspace: { privateTitle: 'Private' } } } }));
vi.mock('@@/js/scroll.js', () => ({ isHeadVisible: () => true, onScrollTop: () => () => {}, scrollToTop: vi.fn() }));
vi.mock('@/components/MkLegacyGridspacePrivateNotes.vue', () => ({ default: { props: ['params'], template: '<div data-legacy>{{ params.mode }}</div>' } }));
vi.mock('@/components/MkTimelineNoteRow.vue', () => ({ default: { props: ['row'], template: '<article>{{ row.note?.text }}</article>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
const api = vi.mocked(misskeyApi);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await nextTick(); };
const page = {
	version: 1, session: 'channel', revision: '1', items: [{
		key: 'https://peer/notes/n', ref: 'ref-n', representation: 'delegated', payload: { id: 'n', uri: 'https://peer/notes/n', createdAt: new Date(0).toISOString(), text: 'Channel note', files: [] },
		sortKey: { sortAt: '1', uri: 'https://peer/notes/n' }, validForMs: 10000,
	}], nextCursor: null, updatesCursor: 'head', complete: true, mode: 'unified',
	sources: [{ source: 'peer', status: 'ok', retryable: false }], revalidateAfterMs: 10000,
};
beforeEach(() => { vi.useFakeTimers(); api.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('a channel-only account uses the channel capability without requiring an old-account private grant', async () => {
	api.mockImplementation((async endpoint => endpoint === 'gridspace/link' ? { granted: false, timeline: { version: 1, enabled: true, kinds: ['channel'] } } : page) as typeof misskeyApi);
	const view = render(PrivateNotes, { props: { params: { mode: 'channel', channelId: 'channel' }, plain: true, alwaysShow: true }, global: { stubs: { MkLoading: true } } });
	await flush();
	expect(view.getByText('Channel note')).toBeTruthy();
	expect(view.container.querySelector('[data-legacy]')).toBeNull();
	expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual(['gridspace/link', 'gridspace/timeline']);
	expect(api.mock.calls[1][1]).toMatchObject({ kind: 'channel', channelId: 'channel' });
});

test.each(['show', 'context', 'home', 'search'] as const)('private-only %s keeps its original semantics even when a merged kind is advertised', async mode => {
	api.mockResolvedValue({ timeline: { version: 1, enabled: true, kinds: [mode] } } as never);
	const view = render(PrivateNotes, { props: { params: { mode }, plain: true, alwaysShow: true }, global: { stubs: { MkLoading: true } } });
	await flush();
	expect(view.container.querySelector('[data-legacy]')?.textContent).toBe(mode);
	// Detail and private-only pages cannot switch on an unrelated list capability.
	expect(api).not.toHaveBeenCalled();
});

test('an unadvertised channel keeps the legacy grant and channel reader', async () => {
	api.mockResolvedValue({ timeline: { version: 1, enabled: true, kinds: ['home'] } } as never);
	const view = render(PrivateNotes, { props: { params: { mode: 'channel', channelId: 'channel' }, plain: true, alwaysShow: true }, global: { stubs: { MkLoading: true } } });
	await flush();
	expect(view.container.querySelector('[data-legacy]')?.textContent).toBe('channel');
	expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual(['gridspace/link']);
});

test.each(['unified', 'local-fallback'] as const)('an empty %s page keeps the automatic sentinel until its cursor reaches a note', async mode => {
	const observers: (() => void)[] = [];
	vi.stubGlobal('IntersectionObserver', class {
		constructor(callback: IntersectionObserverCallback) { observers.push(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
		observe() {}
		disconnect() {}
	});
	api.mockResolvedValueOnce({ timeline: { version: 1, enabled: true, kinds: ['channel'] } } as never)
		.mockResolvedValueOnce({ ...page, items: [], nextCursor: 'empty-1', mode } as never)
		.mockResolvedValueOnce({ ...page, items: [], nextCursor: 'empty-2', mode } as never)
		.mockResolvedValueOnce({ ...page, mode } as never);
	const view = render(PrivateNotes, { props: { params: { mode: 'channel', channelId: 'channel' }, plain: true }, global: { stubs: { MkLoading: true } } });
	await flush();
	expect(view.container.querySelector('[data-timeline-load-more]')).not.toBeNull();
	observers.at(-1)!(); await flush();
	expect(api.mock.calls[2][1]).toMatchObject({ cursor: 'empty-1' });
	expect(view.container.querySelector('[data-timeline-load-more]')).not.toBeNull();
	observers.at(-1)!(); await flush();
	expect(api.mock.calls[3][1]).toMatchObject({ cursor: 'empty-2' });
	expect(view.getByText('Channel note')).toBeTruthy();
	expect(view.container.querySelector('[data-timeline-load-more]')).toBeNull();
});
