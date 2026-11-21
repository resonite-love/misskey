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
	test('placement and native paths remain one row even after more than a hundred intervening notes', async () => {
		const state = emptyTimelineMerge(false);
		state.localPlacement = { before: null, upper: null, ended: false, pending: [] };
		const uri = 'https://shared.example/notes/original';
		const original = ref('local', 'first', 500, uri);
		const others = Array.from({ length: 110 }, (_, i) => ref('local', String(i), 490 - i));
		const read = async () => ({ references: [original, ...others], next: null, upper: original, ended: true });
		const placement = async () => ({ references: [ref('local', 'old', 5, uri)], next: null, upper: null, ended: true });
		const page: TimelineReference[] = [];
		for (let i = 0; i < 6; i++) page.push(...await mergeTimeline(state, 20, read, () => true, compareTimelinePosition, placement));
		expect(page.map(r => r.canonicalUri)).toEqual([original, ...others].map(r => r.canonicalUri));
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
	test('returns buffered home posts once an empty peer window has passed their timestamps', async () => {
		const state = emptyTimelineMerge();
		const local = [ref('local', 'a', 100), ref('local', 'b', 90), ref('local', 'c', 80)];
		let peerReads = 0;
		const result = await mergeTimeline(state, 2, async source => {
			if (source === 'local') return { references: [...local], next: null, upper: local[0], ended: true };
			peerReads++;
			return { references: [], next: ref('peer', 'boundary', 85), upper: ref('peer', 'upper', 110), ended: false };
		});
		expect(result).toEqual(local.slice(0, 2));
		expect(peerReads).toBe(1);
		expect(state.local.pending).toEqual(local.slice(2));
	});
	test('keeps older buffered posts until the missing source reaches them, across page budgets', async () => {
		const state = emptyTimelineMerge();
		let peerReads = 0;
		const read = async (source: 'local' | 'peer') => {
			if (source === 'local') return { references: [ref('local', 'first', 100), ref('local', 'last', 40)], next: null, upper: null, ended: true };
			peerReads++;
			if (peerReads < 5) return { references: [], next: ref('peer', `scan-${peerReads}`, 100 - peerReads * 10), upper: null, ended: false };
			return { references: [ref('peer', 'middle', 50)], next: null, upper: null, ended: true };
		};
		expect((await mergeTimeline(state, 20, read)).map(item => item.noteId)).toEqual(['first']);
		expect(peerReads).toBe(4);
		expect((await mergeTimeline(state, 20, read)).map(item => item.noteId)).toEqual(['middle', 'last']);
	});
	test('only emits same-time rows which precede the other source in the tie order', async () => {
		for (const candidateSource of ['local', 'peer'] as const) {
			const state = emptyTimelineMerge();
			const candidate = ref(candidateSource, 'candidate', 10);
			const result = await mergeTimeline(state, 1, async source => source === candidateSource
				? { references: [candidate], next: null, upper: null, ended: true }
				: { references: [], next: ref(source, 'boundary', 10), upper: null, ended: false });
			expect(result).toEqual(candidateSource === 'local' ? [candidate] : []);
		}
	});
	test('respects ascending clip order when using an empty scan boundary', async () => {
		const state = emptyTimelineMerge();
		const local = [ref('local', 'old', 10), ref('local', 'new', 30)];
		const result = await mergeTimeline(state, 1, async source => source === 'local'
			? { references: [...local], next: null, upper: null, ended: true }
			: { references: [], next: ref('peer', 'boundary', 20), upper: null, ended: false }, () => true, (a, b) => -compareTimelinePosition(a, b));
		expect(result).toEqual([local[0]]);
	});
	test('sparse filtered windows retain all rows in order across repeated checkpoints', async () => {
		for (const ascending of [false, true]) {
			const rows = Array.from({ length: 300 }, (_, index) => ref(index % 2 ? 'peer' : 'local', String(index).padStart(3, '0'), Math.floor(index / 3)));
			const order = (a: TimelineReference, b: TimelineReference) => {
				const byTime = Number(b.sortAt) - Number(a.sortAt);
				const bySource = a.source === b.source ? 0 : a.source === 'local' ? -1 : 1;
				const byId = b.noteId.localeCompare(a.noteId);
				return (ascending ? -1 : 1) * (byTime || bySource || byId);
			};
			const visible = (row: TimelineReference) => Number(row.noteId) % 11 === 0;
			const state = emptyTimelineMerge();
			const actual: TimelineReference[] = [];
			for (let page = 0; page < 100 && (!state.local.ended || !state.peer.ended || state.local.pending.length || state.peer.pending.length); page++) {
				actual.push(...await mergeTimeline(state, 7, async (source, cursor) => {
					const remaining = rows.filter(row => row.source === source && (!cursor.before || order(row, cursor.before as TimelineReference) > 0)).sort(order);
					const scanned = remaining.slice(0, 4);
					const ended = remaining.length <= 4;
					return { references: scanned.filter(visible), next: ended ? null : scanned.at(-1)!, upper: null, ended };
				}, () => true, ascending ? (a, b) => -compareTimelinePosition(a, b) : compareTimelinePosition));
			}
			expect(actual).toEqual(rows.filter(visible).sort(order));
		}
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
