/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { gridspaceNoteId } from './note-protocol.js';
import { openGridspaceSecret, sealGridspaceSecret } from './link-crypto.js';
import type { GridspacePeerConfig } from './peer-protocol.js';

export type HistoryItem = { id: string; date: number };
export type HistoryOptions = { withReplies: boolean; withRenotes: boolean; withFiles: boolean };
export type HistoryViewOptions = HistoryOptions & { withChannelNotes: boolean };
export type HistoryPeerRequest = HistoryOptions & {
	userId: string; counterpartId: string; linkId: string; generation: number;
	viewerId?: string; before?: string; head?: string; limit: number;
};
export type HistoryCursor = { local: string | null; remote: string | null; localHead: string | null; remoteHead: string | null; expires: number };

export function encodeHistoryCursor(peer: GridspacePeerConfig, cursor: HistoryCursor, context: string): string {
	return sealGridspaceSecret(peer, JSON.stringify(cursor), `history-v1:${context}`);
}

export function decodeHistoryCursor(peer: GridspacePeerConfig, value: string, context: string): HistoryCursor {
	const cursor = JSON.parse(openGridspaceSecret(peer, value, `history-v1:${context}`)) as HistoryCursor;
	if (!cursor || !Number.isSafeInteger(cursor.expires) || cursor.expires < Date.now() ||
		![cursor.local, cursor.remote, cursor.localHead, cursor.remoteHead].every(id => id === null || gridspaceNoteId(id))) {
		throw new Error('Invalid history cursor');
	}
	return cursor;
}

/** Each source has its own keyset. Equal timestamps use source, then source ID. */
export function mergeHistory(local: HistoryItem[], remote: HistoryItem[], limit: number) {
	return [
		...local.map(item => ({ ...item, source: 'local' as const })),
		...remote.map(item => ({ ...item, source: 'remote' as const })),
	].sort((a, b) => b.date - a.date || (a.source < b.source ? -1 : a.source > b.source ? 1 : a.id > b.id ? -1 : a.id < b.id ? 1 : 0)).slice(0, limit);
}

export function validateHistoryPage(value: unknown, limit: number, before?: string): { active: boolean; items: HistoryItem[] } {
	const page = value as { active: boolean; items: HistoryItem[] };
	if (!page || typeof page.active !== 'boolean' || !Array.isArray(page.items) || page.items.length > limit || (!page.active && page.items.length > 0)) throw new Error('Invalid history page');
	let previous = before;
	let date = Infinity;
	for (const item of page.items) {
		if (!item || !gridspaceNoteId(item.id) || !Number.isSafeInteger(item.date) || item.date < 0 || item.date > Date.now() + 60000 ||
			(previous != null && item.id >= previous) || item.date > date) throw new Error('Invalid history item');
		previous = item.id;
		date = item.date;
	}
	return page;
}
