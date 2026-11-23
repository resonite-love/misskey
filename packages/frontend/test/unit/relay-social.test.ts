/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { computed, createApp, nextTick } from 'vue';
import RelaySocial from '@/components/MkRlRelaySocialTimeline.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useGridspaceHome } from '@/utility/use-gridspace-home.js';
import { Paginator } from '@/utility/paginator.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/timeline-stream.js', () => ({ subscribeTimeline: vi.fn(() => () => {}) }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { enablePullToRefresh: false, enableInfiniteScroll: false } } }));
vi.mock('@/components/MkStreamingNotesTimeline.vue', () => ({ default: { props: ['src', 'withLocalOnly', 'confirmedTimeline'], template: '<div data-unified :data-confirmed="confirmedTimeline">{{ src }}:{{ withLocalOnly }}</div>' } }));
vi.mock('@/components/MkLegacyRlRelaySocialTimeline.vue', () => ({ default: { template: '<div data-legacy/>' } }));

const api = vi.mocked(misskeyApi);
const settle = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await nextTick(); } };
let unmount: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); api.mockReset(); });
afterEach(() => { unmount?.(); unmount = undefined; cleanup(); vi.useRealTimers(); });

test('relay social uses the common timeline when the server advertises the exact surface', async () => {
	api.mockResolvedValue({ timeline: { version: 1, enabled: true, kinds: ['relay-social'] } } as never);
	const view = render(RelaySocial, { props: { withLocalOnly: false }, global: { stubs: { MkLoading: true } } });
	await settle();
	expect(view.getByText('rl-relay-social:false')).toBeTruthy();
	expect(view.container.querySelector('[data-confirmed="true"]')).not.toBeNull();
	expect(view.container.querySelector('[data-legacy]')).toBeNull();
});

test('older servers retain the original relay rather than silently dropping relay hosts', async () => {
	api.mockResolvedValue({ timeline: { version: 1, enabled: true, kinds: ['social'] } } as never);
	const view = render(RelaySocial, { global: { stubs: { MkLoading: true } } });
	await settle();
	expect(view.container.querySelector('[data-legacy]')).not.toBeNull();
	expect(view.container.querySelector('[data-unified]')).toBeNull();
});

test('omitted relay filters retain the original enabled defaults', async () => {
	api.mockResolvedValue({ timeline: { version: 1, enabled: true, kinds: ['relay-social'] } } as never);
	const view = render(RelaySocial, { global: { stubs: { MkLoading: true } } });
	await settle();
	expect(view.getByText('rl-relay-social:true')).toBeTruthy();
});

test('the unified relay reads linked channel bodies and rechecks them after access is removed', async () => {
	const page = { version: 1, session: 's', revision: 'r', nextCursor: null, updatesCursor: 'u', complete: true,
		mode: 'unified', sources: [], revalidateAfterMs: 30000, items: [{
			key: 'https://peer/notes/n', ref: 'ref', sortKey: { sortAt: '1', uri: 'https://peer/notes/n' },
			representation: 'delegated', validForMs: 60000, payload: {
				id: 'n', uri: 'https://peer/notes/n', createdAt: new Date(0).toISOString(), text: 'Linked channel', channelId: 'c', files: [],
			},
		}] };
	api.mockResolvedValueOnce({ timeline: { version: 1, enabled: true, kinds: ['relay-social'] } } as never)
		.mockResolvedValueOnce(page as never);
	const paginator = new Paginator('notes/hybrid-timeline', {});
	let home!: ReturnType<typeof useGridspaceHome>;
	const app = createApp({ setup() {
		home = useGridspaceHome(paginator, computed(() => ({ mode: 'home', withLocalOnly: false })), () => true, computed(() => true), computed(() => 'relay-social'));
		return () => null;
	} });
	app.mount(document.createElement('div')); unmount = () => app.unmount();
	await settle();
	expect(api.mock.calls[1][1]).toMatchObject({ kind: 'relay-social', withLocalOnly: false });
	expect(home.rows.value).toEqual([expect.objectContaining({ kind: 'private', note: expect.objectContaining({ text: 'Linked channel' }) })]);
	api.mockResolvedValueOnce({ ...page, items: [], removed: ['https://peer/notes/n'] } as never);
	await home.refresh();
	expect(home.rows.value).toEqual([]);
});

test('a confirmed relay does not request capabilities again or switch feeds on a read failure', async () => {
	api.mockRejectedValue(new Error('offline'));
	const paginator = new Paginator('notes/hybrid-timeline', {});
	const init = vi.spyOn(paginator, 'init');
	let home!: ReturnType<typeof useGridspaceHome>;
	const app = createApp({ setup() {
		home = useGridspaceHome(paginator, computed(() => ({ mode: 'home' })), () => true, computed(() => true), computed(() => 'relay-social'), { capabilityConfirmed: true });
		return () => null;
	} });
	app.mount(document.createElement('div')); unmount = () => app.unmount();
	await settle();
	expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual(['gridspace/timeline']);
	expect(home.integrated.value).toBe(true);
	expect(home.initialError.value).toBe(true);
	expect(init).not.toHaveBeenCalled();
});
