/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import LoadMore from '@/components/MkTimelineLoadMore.vue';
import PrivateNotes from '@/components/MkGridspacePrivateNotes.vue';

const { preference, api } = vi.hoisted(() => ({ preference: { automatic: undefined as unknown as { value: boolean } }, api: vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { get r() { return { enableInfiniteScroll: preference.automatic }; }, get s() { return { enableInfiniteScroll: preference.automatic.value, animation: false, enablePullToRefresh: false }; } } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { loadMore: 'More', retry: 'Retry', channel: 'Channel', noNotes: 'Empty', _gridspace: { channelNotesUnavailable: 'Unavailable' } } } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkGridspacePrivateNoteRow.vue', () => ({ default: { props: ['note'], template: '<article>{{ note.text }}</article>' } }));
vi.mock('@@/js/scroll.js', () => ({ isHeadVisible: () => true, onScrollTop: () => () => {}, scrollToTop: vi.fn() }));

const observers: { fire: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
async function flushPromises() { for (let i = 0; i < 25; i++) await Promise.resolve(); await nextTick(); }
beforeEach(() => {
	preference.automatic = ref(true); api.mockReset(); observers.length = 0;
	vi.stubGlobal('IntersectionObserver', class {
		disconnect = vi.fn();
		constructor(callback: IntersectionObserverCallback) {
			observers.push({ fire: () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver), disconnect: this.disconnect });
		}
		observe() {}
	});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('automatic mode hides the button and rearms after a page finishes', async () => {
	const view = render(LoadMore, { props: { hasMore: true, loading: false } });
	await nextTick();
	expect(view.queryByRole('button', { name: 'More' })).toBeNull();
	observers.at(-1)!.fire(); expect(view.emitted('load')).toHaveLength(1);
	const first = observers.at(-1)!;
	await view.rerender({ loading: true });
	expect(first.disconnect).toHaveBeenCalled();
	first.fire(); expect(view.emitted('load')).toHaveLength(1);
	await view.rerender({ loading: false });
	observers.at(-1)!.fire(); expect(view.emitted('load')).toHaveLength(2);
	await view.rerender({ hasMore: false });
	observers.at(-1)!.fire(); expect(view.emitted('load')).toHaveLength(2);
});

test('manual preference keeps the button and changing the preference enables scrolling', async () => {
	preference.automatic.value = false;
	const view = render(LoadMore, { props: { hasMore: true, loading: false } });
	await nextTick();
	expect(observers).toHaveLength(0);
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	expect(view.emitted('load')).toHaveLength(1);
	preference.automatic.value = true; await nextTick();
	expect(view.queryByRole('button', { name: 'More' })).toBeNull();
	observers.at(-1)!.fire(); expect(view.emitted('load')).toHaveLength(2);
	const old = observers.at(-1)!;
	preference.automatic.value = false; await nextTick();
	old.fire(); expect(view.emitted('load')).toHaveLength(2);
});

test('a channel bottom marker rearms after delayed reauthorization on tab return', async () => {
	const note = { id: 'first', uri: 'https://peer/notes/first', createdAt: '2026-11-14T00:00:00Z', text: 'first', files: [] };
	const page = { notes: [note], cursor: 'older', observedAt: '2026-11-14T00:00:00Z' };
	let authorize!: (value: unknown) => void;
	api.mockImplementation(async (_endpoint, params) => {
		if (params.mode === 'validate') return new Promise(resolve => { authorize = resolve; });
		if (params.rangeStartAt) return { ...page, notes: [], cursor: null };
		return params.cursor ? { ...page, notes: [], cursor: null } : page;
	});
	const view = render(PrivateNotes, { props: { params: { mode: 'channel', channelId: 'channel' }, plain: true, alwaysShow: true }, global: { stubs: { MkLoading: true } } });
	await flushPromises();
	const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
	const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
	document.dispatchEvent(new Event('visibilitychange')); await nextTick();
	visibility.mockReturnValue('visible'); hidden.mockReturnValue(false);
	document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
	const premature = observers.at(-1)!;
	premature.fire(); await flushPromises();
	expect(api.mock.calls.some(([, params]) => params.cursor === 'older')).toBe(false);
	authorize({ ...page, cursor: null }); await flushPromises();
	expect(observers.at(-1)).not.toBe(premature);
	observers.at(-1)!.fire(); await flushPromises();
	expect(api.mock.calls.some(([, params]) => params.cursor === 'older')).toBe(true);
	expect(view.queryByRole('button', { name: 'More' })).toBeNull();
});

test('hidden tabs, disabled loading and unmounted observers cannot request pages', async () => {
	const view = render(LoadMore, { props: { hasMore: true, loading: false } });
	await nextTick();
	const first = observers.at(-1)!;
	const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
	document.dispatchEvent(new Event('visibilitychange')); await nextTick();
	first.fire(); expect(view.emitted('load')).toBeUndefined();
	visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); await nextTick();
	await view.rerender({ disabled: true });
	observers.at(-1)!.fire(); expect(view.emitted('load')).toBeUndefined();
	view.unmount(); first.fire(); expect(view.emitted('load')).toBeUndefined();
});

test('a linked channel loads the next cursor on scroll, including an empty filtered page', async () => {
	const note = (id: string) => ({ id, uri: `https://peer/notes/${id}`, createdAt: '2026-11-14T00:00:00Z', text: id, files: [] });
	api.mockResolvedValueOnce({ notes: [note('first')], cursor: 'older', observedAt: '2026-11-14T00:00:00Z' })
		.mockResolvedValueOnce({ notes: [], cursor: 'oldest', observedAt: '2026-11-14T00:00:00Z' })
		.mockResolvedValueOnce({ notes: [note('last')], cursor: null, observedAt: '2026-11-14T00:00:00Z' });
	const view = render(PrivateNotes, { props: { params: { mode: 'channel', channelId: 'channel' }, plain: true, alwaysShow: true }, global: { stubs: { MkLoading: true } } });
	await flushPromises(); await nextTick();
	expect(view.getByText('first')).toBeTruthy();
	expect(view.queryByRole('button', { name: 'More' })).toBeNull();
	observers.at(-1)!.fire(); await flushPromises(); await nextTick();
	expect(api.mock.calls[1][1]).toMatchObject({ cursor: 'older', channelId: 'channel' });
	observers.at(-1)!.fire(); await flushPromises(); await nextTick();
	expect(api.mock.calls[2][1]).toMatchObject({ cursor: 'oldest' });
	expect(view.getByText('last')).toBeTruthy();
	expect(view.container.querySelector('[data-timeline-load-more]')).toBeNull();
});

test('an explicit manual override wins over the automatic preference', async () => {
 const view = render(LoadMore, { props: { hasMore: true, loading: false, automatic: false } });
 await nextTick();
 expect(view.getByRole('button', { name: 'More' })).toBeTruthy();
 expect(observers).toHaveLength(0);
 await fireEvent.click(view.getByRole('button', { name: 'More' }));
 expect(view.emitted('load')).toHaveLength(1);
});
