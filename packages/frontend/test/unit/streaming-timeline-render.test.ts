/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { compileTemplate, parse } from 'vue/compiler-sfc';
import { cleanup, render } from '@testing-library/vue';
import source from '@/components/MkStreamingNotesTimeline.vue?raw';
import { TimelineClient } from '@/utility/timeline-client.js';
import LoadMore from '@/components/MkTimelineLoadMore.vue';
import type { TimelineResponse } from '@/utility/timeline-client.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { enableInfiniteScroll: true } } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { loadMore: 'More' } } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));

const compiled = compileTemplate({
	source: parse(source).descriptor.template!.content,
	filename: 'MkStreamingNotesTimeline.vue',
	id: 'streaming-timeline-test',
	compilerOptions: { mode: 'function', prefixIdentifiers: true },
});
if (compiled.errors.length > 0) throw new Error(String(compiled.errors));
const renderTimeline = new Function('Vue', compiled.code)(Vue);

function normal(id: string, ad = false) {
	return { kind: 'normal', key: `https://example.com/notes/${id}`, createdAt: '2026-11-14T00:00:00.000Z', note: { id, _shouldInsertAd_: ad } };
}

function mountTimeline(initial: ReturnType<typeof normal>[], animation = true) {
	const rows = Vue.shallowRef(initial);
	const Note = Vue.defineComponent({
		props: ['row'],
		setup(props) {
			return () => props.row.kind === 'normal' ? Vue.h('article', { 'data-note': props.row.note.id }, props.row.note.id) : Vue.h('div', { 'data-placeholder': '' });
		},
	});
	const Timeline = Vue.defineComponent({
		render: renderTimeline,
		setup: () => ({
			TransitionGroup: Vue.TransitionGroup,
			prefer: { s: { animation, enablePullToRefresh: false, enableInfiniteScroll: false } },
			paginator: { fetching: Vue.ref(false), error: Vue.ref(false) },
			home: { rows, error: Vue.ref(false), busy: Vue.ref(false), hasMore: Vue.ref(false), queuedCount: Vue.ref(0), pagingKey: Vue.ref(0), loading: Vue.ref(false), initialLoading: Vue.ref(false), initialError: Vue.ref(false) },
			src: 'home',
			clearLeavingPrivateNote: vi.fn(),
			isSeparatorNeeded: () => false,
			getSeparatorInfo: vi.fn(),
			i18n: { ts: { loadMore: 'More' } },
		}),
	});
	const view = render(Timeline, {
		global: {
			mocks: { $style: {} },
			components: { MkTimelineNoteRow: Note, MkAd: { render: () => Vue.h('aside', { 'data-ad': '' }, 'Ad') } },
			directives: { appear: {} },
			stubs: { transition: false, 'transition-group': false, MkButton: true, MkInfo: true, MkLoading: true, MkError: true, MkResult: true, MkGridspacePrivateNoteRow: true, MkTimelineLoadMore: true },
		},
	});
	return { view, rows };
}

async function settleTransitions() {
	await Vue.nextTick();
	await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('streaming timeline rendering', () => {
	test.each(['unified', 'local-fallback'] as const)('an empty %s home page renders and rearms its automatic continuation', async mode => {
		const observers: (() => void)[] = [];
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: IntersectionObserverCallback) { observers.push(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
			observe() {}
			disconnect() {}
		});
		const response = (cursor: string | null, items: TimelineResponse['items'] = []): TimelineResponse => ({
			version: 1, session: 's', revision: 'r', items, nextCursor: cursor, updatesCursor: 'u', complete: true, mode, sources: [], revalidateAfterMs: 10000,
		});
		const request = vi.fn().mockResolvedValueOnce(response('empty-1')).mockResolvedValueOnce(response('empty-2')).mockResolvedValueOnce(response(null, [{
			key: 'found', ref: 'found', representation: 'normal', sortKey: { sortAt: '1', uri: 'found' }, validForMs: null,
			payload: { id: 'found', createdAt: '2026-11-14T00:00:00Z' } as never,
		}]));
		const client = new TimelineClient({ kind: 'home' }, { request });
		await client.reload();
		const Timeline = Vue.defineComponent({ render: renderTimeline, setup: () => ({
			TransitionGroup: Vue.TransitionGroup, src: 'home', clearLeavingPrivateNote: vi.fn(), isSeparatorNeeded: () => false, getSeparatorInfo: vi.fn(),
			prefer: { s: { animation: false, enablePullToRefresh: false } }, i18n: { ts: { _gridspace: { homeUnavailable: 'Unavailable' }, retry: 'Retry' } },
			home: { rows: client.rows, error: client.error, busy: client.busy, hasMore: client.hasMore, queuedCount: client.queuedCount, pagingKey: client.pagingKey,
				loading: client.busy, initialLoading: client.loading, initialError: Vue.computed(() => client.failed.value && client.rows.value.length === 0),
				fetchOlder: client.load, reload: client.reload },
		}) });
		const view = render(Timeline, { global: { mocks: { $style: {} }, components: { MkTimelineLoadMore: LoadMore,
			MkTimelineNoteRow: { props: ['row'], template: '<article>{{ row.note.id }}</article>' } },
			stubs: { MkInfo: { template: '<aside><slot/></aside>' }, MkButton: true, MkLoading: true, MkError: true, MkResult: true } } });
		const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await Vue.nextTick(); };
		await flush(); expect(view.container.querySelector('[data-timeline-load-more]')).not.toBeNull();
		observers.at(-1)!(); await flush(); expect(request.mock.calls[1][1]).toMatchObject({ cursor: 'empty-1' });
		expect(view.container.querySelector('[data-timeline-load-more]')).not.toBeNull();
		observers.at(-1)!(); await flush(); expect(request.mock.calls[2][1]).toMatchObject({ cursor: 'empty-2' });
		expect(view.getByText('found')).toBeTruthy();
		expect(view.container.querySelector('[data-timeline-load-more]')).toBeNull();
		client.dispose();
	});
	test('removes the matching ad when an advertised note leaves the timeline', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { view, rows } = mountTimeline([normal('4'), normal('3', true), normal('2'), normal('1', true)]);
		expect(view.container.querySelectorAll('[data-ad]')).toHaveLength(2);
		rows.value = [normal('5'), normal('4'), normal('3', true), normal('2')];
		await settleTransitions();
		expect(view.container.querySelectorAll('[data-ad]')).toHaveLength(1);
		expect(Array.from(view.container.querySelectorAll('[data-note]')).map(element => element.getAttribute('data-note'))).toEqual(['5', '4', '3', '2']);
		expect(warn.mock.calls.some(args => String(args[0]).includes('Duplicate keys'))).toBe(false);
	});

	test.each([true, false])('does not accumulate ads after repeated additions and trimming (animation: %s)', async (animation) => {
		const { view, rows } = mountTimeline([normal('4'), normal('3', true), normal('2'), normal('1', true)], animation);
		for (let id = 5; id < 20; id++) {
			rows.value = [normal(String(id), id % 3 === 0), ...rows.value].slice(0, 4);
			await settleTransitions();
			expect(view.container.querySelectorAll('[data-ad]')).toHaveLength(rows.value.filter(row => row.note._shouldInsertAd_).length);
			expect(Array.from(view.container.querySelectorAll('[data-note]')).map(element => element.getAttribute('data-note'))).toEqual(rows.value.map(row => row.note.id));
		}
	});

	test('removes only the ad when an existing note loses its ad marker', async () => {
		const { view, rows } = mountTimeline([normal('2', true), normal('1')]);
		rows.value = [normal('2'), normal('1')];
		await settleTransitions();
		expect(view.container.querySelectorAll('[data-ad]')).toHaveLength(0);
		expect(Array.from(view.container.querySelectorAll('[data-note]')).map(element => element.getAttribute('data-note'))).toEqual(['2', '1']);
	});
});
