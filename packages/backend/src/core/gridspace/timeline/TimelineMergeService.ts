/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { compareTimelinePosition } from './timeline-protocol.js';
import type { TimelinePosition, TimelineReference } from './timeline-protocol.js';

export type TimelineSourceCursor = { before: TimelinePosition | null; upper: TimelinePosition | null; ended: boolean; pending: TimelineReference[] };
export type TimelineMergeState = { local: TimelineSourceCursor; peer: TimelineSourceCursor; seen: string[]; owners: Record<string, 'local' | 'peer'> };
export type TimelineRead = (source: 'local' | 'peer', cursor: TimelineSourceCursor) => Promise<{ references: TimelineReference[]; next: TimelinePosition | null; upper: TimelinePosition | null; ended: boolean }>;

/** Pure reference merge. The caller checkpoints only the successfully completed state. */
export async function mergeTimeline(state: TimelineMergeState, limit: number, read: TimelineRead, canRead: () => boolean = () => true, compare = compareTimelinePosition): Promise<TimelineReference[]> {
	const output: TimelineReference[] = [];
	const seen = new Set(state.seen);
	let reads = 0;
	let peerReads = 0;
	while (output.length < limit) {
		const a = state.local.pending[0];
		const b = state.peer.pending[0];
		const candidate = !b || (a && compare(a, b) <= 0) ? a : b;
		// An empty filtered page still proves that every unread row is beyond
		// its exclusive scan boundary. Do not wait for a matching row when the
		// other source already has a candidate ahead of that boundary.
		const missing = (['local', 'peer'] as const).find(source => {
			const cursor = state[source];
			return !cursor.pending.length && !cursor.ended &&
				(!candidate || !cursor.before || compare(candidate, { ...cursor.before, source }) > 0);
		});
		if (missing) {
			if (!canRead() || reads >= 8 || (missing === 'peer' && peerReads >= 4)) break;
			reads++;
			if (missing === 'peer') peerReads++;
			const cursor = state[missing];
			const page = await read(missing, cursor);
			if (!page.ended && !page.next) throw new Error('Timeline source made no progress');
			cursor.before = page.next;
			cursor.upper ??= page.upper;
			cursor.pending = page.references;
			cursor.ended = page.ended;
			continue;
		}
		if (!candidate) break;
		const chosen = state[candidate.source].pending.shift()!;
		state.owners[chosen.canonicalUri] ??= chosen.source;
		if (seen.has(chosen.canonicalUri)) continue;
		seen.add(chosen.canonicalUri);
		state.seen.push(chosen.canonicalUri);
		output.push(chosen);
	}
	if (state.seen.length + state.local.pending.length + state.peer.pending.length > 2000) throw new Error('Timeline session reference limit reached');
	// Source ownership is disjoint; only a bounded recent duplicate guard is
	// necessary across the next checkpoint, not the whole consumed history.
	state.seen = state.seen.slice(-100);
	return output;
}

export function emptyTimelineMerge(peer = true): TimelineMergeState {
	return { local: { before: null, upper: null, ended: false, pending: [] }, peer: { before: null, upper: null, ended: !peer, pending: [] }, seen: [], owners: {} };
}
