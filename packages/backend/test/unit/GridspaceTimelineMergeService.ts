/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { emptyTimelineMerge, mergeTimeline } from '@/core/gridspace/timeline/TimelineMergeService.js';
import { compareTimelinePosition, type TimelineReference } from '@/core/gridspace/timeline/timeline-protocol.js';

const ref = (source: 'local' | 'peer', id: string, time: number, uri = `https://${source}.example/notes/${id}`): TimelineReference => ({ source, noteId: id, canonicalUri: uri, sortAt: String(time), generation: 1, normalized: true });

describe('unified timeline reference merge', () => {
	test('keeps pending rows and pages through 100000 equal times with source IDs', async () => {
		const all = Array.from({ length: 100000 }, (_, i) => ref(i % 2 === 0 ? 'local' : 'peer', String(i).padStart(6, '0'), 1));
		const sources = { local: all.filter(row => row.source === 'local').reverse(), peer: all.filter(row => row.source === 'peer').reverse() };
		const state = emptyTimelineMerge();
		const actual: TimelineReference[] = [];
		for (let page = 0; page < 4; page++) {
			actual.push(...await mergeTimeline(state, 20, async (source, cursor) => {
				const candidates = sources[source].filter(row => !cursor.before || row.noteId < cursor.before.noteId!);
				const refs = candidates.slice(0, 21);
				return { references: refs.slice(0, 20), next: refs.length > 20 ? refs[19] : null, upper: cursor.upper ?? refs[0], ended: refs.length <= 20 };
			}));
		}
		// Independent expected comparator, not the production merge/comparison helper.
		const expected = [...all].sort((a, b) => a.source === b.source ? b.noteId.localeCompare(a.noteId) : a.source === 'local' ? -1 : 1).slice(0, 80);
		expect(actual).toEqual(expected);
	});
	test('advances through filtered empty windows without emitting ahead of a frontier', async () => {
		const state = emptyTimelineMerge();
		let calls = 0;
		const result = await mergeTimeline(state, 10, async (source, cursor) => {
			if (source === 'peer' && calls++ < 2) return { references: [], next: ref(source, String(calls), 10), upper: cursor.upper, ended: false };
			return { references: [ref(source, '001', source === 'local' ? 1 : 2)], next: null, upper: null, ended: true };
		});
		expect(result.map(row => row.source)).toEqual(['peer', 'local']);
	});
	test('same URI is deduplicated but independent renotes remain distinct', async () => {
		const state = emptyTimelineMerge();
		const result = await mergeTimeline(state, 10, async source => ({ references: [ref(source, 'b', 3, 'https://shared.example/note'), ref(source, 'a', 2)], next: null, upper: null, ended: true }));
		expect(result).toHaveLength(3);
		expect(result[0].source).toBe('local');
	});
	test('failure never advances the original immutable checkpoint', async () => {
		const original = emptyTimelineMerge();
		const working = structuredClone(original);
		await expect(mergeTimeline(working, 10, async source => {
			if (source === 'peer') throw new Error('peer unavailable');
			return { references: [ref(source, 'a', 2)], next: null, upper: null, ended: true };
		})).rejects.toThrow('peer unavailable');
		expect(original).toEqual(emptyTimelineMerge());
	});
	test('four-read budget checkpoints sparse progress so the sixth window is reachable', async () => {
		const state = emptyTimelineMerge();
		let remoteWindows = 0;
		const read = async (source: 'local' | 'peer') => {
			if (source === 'local') return { references: [], next: null, upper: null, ended: true };
			remoteWindows++;
			if (remoteWindows < 6) return { references: [], next: ref(source, String(remoteWindows), 10 - remoteWindows), upper: null, ended: false };
			return { references: [ref(source, 'target', 1)], next: null, upper: null, ended: true };
		};
		expect(await mergeTimeline(state, 20, read)).toEqual([]);
		expect(remoteWindows).toBe(4);
		expect(state.peer.before?.noteId).toBe('4');
		expect((await mergeTimeline(state, 20, read)).map(item => item.noteId)).toEqual(['target']);
	});
	test('deadline pauses after progress without rolling back the source cursor', async () => {
		const state = emptyTimelineMerge(); let windows = 0;
		const read = async (source: 'local' | 'peer') => {
			if (source === 'local') return { references: [], next: null, upper: null, ended: true };
			windows++;
			return { references: [], next: ref(source, String(windows), 10 - windows), upper: null, ended: false };
		};
		await mergeTimeline(state, 20, read, () => windows < 2);
		expect(state.peer.before?.noteId).toBe('2');
		await mergeTimeline(state, 20, read, () => windows < 4);
		expect(state.peer.before?.noteId).toBe('4');
	});
	test('equal time tie orders source then own ID, never compares unrelated short IDs first', () => {
		expect(compareTimelinePosition(ref('local', '001', 4), ref('peer', '999', 4))).toBeLessThan(0);
		expect(compareTimelinePosition(ref('local', '999', 4), ref('local', '001', 4))).toBeLessThan(0);
	});
});
