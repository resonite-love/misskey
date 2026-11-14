/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { compileTemplate, parse } from 'vue/compiler-sfc';
import { cleanup, render } from '@testing-library/vue';
import source from '@/components/MkStreamingNotesTimeline.vue?raw';

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
		props: ['note'],
		setup(props) {
			const id = props.note.id;
			return () => Vue.h('article', { 'data-note': id }, id);
		},
	});
	const Timeline = Vue.defineComponent({
		render: renderTimeline,
		setup: () => ({
			TransitionGroup: Vue.TransitionGroup,
			prefer: { s: { animation, enablePullToRefresh: false, enableInfiniteScroll: false } },
			paginator: { fetching: Vue.ref(false), error: Vue.ref(false) },
			home: { rows, error: Vue.ref(false), busy: Vue.ref(false), hasMore: Vue.ref(false), queuedCount: Vue.ref(0), pagingKey: Vue.ref(0), loading: Vue.ref(false) },
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
			components: { MkNote: Note, MkAd: { render: () => Vue.h('aside', { 'data-ad': '' }, 'Ad') } },
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
	vi.restoreAllMocks();
});

describe('streaming timeline rendering', () => {
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
