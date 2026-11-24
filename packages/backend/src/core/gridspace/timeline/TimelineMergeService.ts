/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { compareTimelinePosition } from './timeline-protocol.js';
import type { TimelinePosition, TimelineReference } from './timeline-protocol.js';
import type { TimelineKnownReference } from './TimelineSessionStore.js';

export type TimelineSourceCursor = { before: TimelinePosition | null; upper: TimelinePosition | null; ended: boolean; pending: TimelineReference[] };
export type TimelineMergeState = { local: TimelineSourceCursor; peer: TimelineSourceCursor; localPlacement?: TimelineSourceCursor; peerPlacement?: TimelineSourceCursor; seen: string[]; owners: Record<string, 'local' | 'peer'> };
export type TimelineRead = (source: 'local' | 'peer', cursor: TimelineSourceCursor) => Promise<{ references: TimelineReference[]; next: TimelinePosition | null; upper: TimelinePosition | null; ended: boolean }>;

/** Pure reference merge. The caller checkpoints only the successfully completed state. */
export async function mergeTimeline(state: TimelineMergeState, limit: number, read: TimelineRead, canRead: () => boolean = () => true, compare = compareTimelinePosition, readPlacement?: TimelineRead, readKnown?: (uris: string[]) => Promise<Record<string, TimelineKnownReference>>): Promise<TimelineReference[]> {
	const output: TimelineReference[] = [];
	const seen = new Set(state.seen);
	const checked = new Set<string>();
	const restoreKnown = async (refs: TimelineReference[]) => {
		if (!readKnown) return;
		const uris = [...new Set(refs.map(ref => ref.canonicalUri))].filter(uri => !checked.has(uri));
		if (!uris.length) return;
		const known = await readKnown(uris);
		for (const uri of uris) checked.add(uri);
		for (const [uri, value] of Object.entries(known)) {
			if (value.source) state.owners[uri] = value.source;
			if (value.seen) seen.add(uri);
		}
	};
	await restoreKnown([state.local, state.peer, state.localPlacement, state.peerPlacement].flatMap(cursor => cursor?.pending ?? []));
	let reads = 0;
	let peerReads = 0;
	while (output.length < limit) {
		const lanes = (['local', 'peer', 'localPlacement', 'peerPlacement'] as const).flatMap(key => {
			const cursor = state[key];
			const placement = key === 'localPlacement' || key === 'peerPlacement';
			const source = key === 'local' || key === 'localPlacement' ? 'local' : 'peer';
			return cursor ? [{ cursor, source: source as 'local' | 'peer', read: placement ? readPlacement! : read }] : [];
		});
		const heads = lanes.filter(lane => lane.cursor.pending.length);
		heads.sort((a, b) => compare(a.cursor.pending[0], b.cursor.pending[0]));
		const first = heads[0];
		const candidate = first?.cursor.pending[0];
		const missing = lanes.find(({ cursor, source }) => !cursor.pending.length && !cursor.ended &&
			(!candidate || !cursor.before || compare(candidate, { ...cursor.before, source }) > 0));
		if (missing) {
			if (!canRead() || reads >= (state.localPlacement ? 12 : 8) || (missing.source === 'peer' && peerReads >= 4)) break;
			reads++;
			if (missing.source === 'peer') peerReads++;
			const cursor = missing.cursor;
			const page = await missing.read(missing.source, cursor);
			if (!page.ended && !page.next) throw new Error('Timeline source made no progress');
			await restoreKnown(page.references);
			cursor.before = page.next;
			cursor.upper ??= page.upper;
			cursor.pending = page.references;
			cursor.ended = page.ended;
			continue;
		}
		if (!candidate) break;
		const chosen = first.cursor.pending.shift()!;
		state.owners[chosen.canonicalUri] ??= chosen.source;
		if (seen.has(chosen.canonicalUri)) continue;
		seen.add(chosen.canonicalUri);
		state.seen.push(chosen.canonicalUri);
		output.push(chosen);
	}
	if (readKnown || (!state.localPlacement && !state.peerPlacement)) {
		state.seen = state.seen.slice(-100);
	}
	if (readKnown) {
		const retained = new Set([...state.seen, ...[state.local, state.peer, state.localPlacement, state.peerPlacement].flatMap(cursor => cursor?.pending.map(ref => ref.canonicalUri) ?? [])]);
		state.owners = Object.fromEntries(Object.entries(state.owners).filter(([uri]) => retained.has(uri)));
	}
	return output;
}

export function emptyTimelineMerge(peer = true): TimelineMergeState {
	return { local: { before: null, upper: null, ended: false, pending: [] }, peer: { before: null, upper: null, ended: !peer, pending: [] }, seen: [], owners: {} };
}
