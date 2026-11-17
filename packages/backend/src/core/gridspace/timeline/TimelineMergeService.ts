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
export async function mergeTimeline(state: TimelineMergeState, limit: number, read: TimelineRead, canRead: () => boolean = () => true): Promise<TimelineReference[]> {
	const output: TimelineReference[] = [];
	const seen = new Set(state.seen);
	let reads = 0;
	let peerReads = 0;
	while (output.length < limit) {
		for (const source of ['local', 'peer'] as const) {
			const cursor = state[source];
			while (!cursor.pending.length && !cursor.ended) {
				if (!canRead()) return output;
				if (source === 'peer' && peerReads >= 4) return output;
				if (++reads > 8) return output;
				if (source === 'peer') peerReads++;
				const page = await read(source, cursor);
				if (!page.ended && !page.next) throw new Error('Timeline source made no progress');
				cursor.before = page.next;
				cursor.upper ??= page.upper;
				cursor.pending = page.references;
				cursor.ended = page.ended;
			}
		}
		// Never emit a row before both source frontiers are known.
		if ((!state.local.pending.length && !state.local.ended) || (!state.peer.pending.length && !state.peer.ended)) break;
		const a = state.local.pending[0];
		const b = state.peer.pending[0];
		if (!a && !b) break;
		const chosen = !b || (a && compareTimelinePosition(a, b) <= 0) ? state.local.pending.shift()! : state.peer.pending.shift()!;
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
