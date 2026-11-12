/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { gridspaceNoteId } from './note-protocol.js';
import type { GridspacePeerConfig } from './peer-protocol.js';

/** Reaction sharing does not make a restricted note eligible for the shared LTL. */
export function supportsGridspaceReactions(note: { userHost: string | null; uri: string | null; channelId: string | null }, peer: GridspacePeerConfig | null): boolean {
	if (!peer || note.channelId !== null) return false;
	const prefix = `${peer.peerOrigin}/notes/`;
	return note.userHost === null || (note.userHost === new URL(peer.peerOrigin).host && note.uri?.startsWith(prefix) === true && gridspaceNoteId(note.uri.slice(prefix.length)));
}

export const GRIDSPACE_REACTIONS_PATH = '/gridspace/v1/reactions';
export type ReactionPosition = { time: number; id: string; origin: string };
export type ReactionRow = ReactionPosition & { reaction: string; userUri: string };
export type ReactionPeerRequest = {
	mode: 'show' | 'list'; uris: string[]; viewerId?: string;
	type?: string | null; limit?: number; before?: ReactionPosition; after?: ReactionPosition;
};
export type ReactionSnapshot = {
	uri: string; reactions: Record<string, number>; reactionEmojis: Record<string, string>;
	reactionAcceptance: string | null; revision: string; rows?: ReactionRow[];
};

export function canonicalReaction(reaction: string, origin: string): string {
	return reaction.replace(/^:([\w+-]+)(?:@\.)?:$/, `:$1@${new URL(origin).host}:`);
}

export function localReaction(reaction: string, origin: string): string {
	const suffix = `@${new URL(origin).host}:`;
	return reaction.startsWith(':') && reaction.endsWith(suffix) ? reaction.slice(0, -suffix.length) + '@.:' : reaction;
}

export function reactionPosition(value: string | undefined, origins: string[]): ReactionPosition | undefined {
	if (!value?.startsWith('gr1') || value.length <= 32) return undefined;
	if (value.length > 2048 || !/^gr1(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Invalid reaction cursor');
	const result = JSON.parse(Buffer.from(value.slice(3), 'hex').toString()) as ReactionPosition;
	if (!result || !Number.isSafeInteger(result.time) || result.time < 0 || result.time > 4102444800000 || !gridspaceNoteId(result.id) || !origins.includes(result.origin)) throw new Error('Invalid reaction cursor');
	return result;
}

export function encodeReactionPosition(row: ReactionPosition): string {
	return 'gr1' + Buffer.from(JSON.stringify({ time: row.time, id: row.id, origin: row.origin })).toString('hex');
}

export function compareReactionRows(a: ReactionPosition, b: ReactionPosition): number {
	return a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
}

export function validateReactionSnapshots(value: unknown, input: ReactionPeerRequest, peerOrigin: string): ReactionSnapshot[] {
	if (!Array.isArray(value) || value.length > input.uris.length) throw new Error('Invalid reactions');
	const seen = new Set<string>();
	for (const item of value as ReactionSnapshot[]) {
		if (!item || !input.uris.includes(item.uri) || seen.has(item.uri)) throw new Error('Invalid reaction note');
		seen.add(item.uri);
		if (!item.reactions || typeof item.reactions !== 'object' || Array.isArray(item.reactions) || !item.reactionEmojis || typeof item.reactionEmojis !== 'object' || Array.isArray(item.reactionEmojis) || typeof item.revision !== 'string' || !/^[0-9a-f]{64}$/.test(item.revision)) throw new Error('Invalid reaction state');
		if (Object.entries(item.reactions).some(([key, count]) => key.length > 260 || !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid reaction count');
		if (Object.values(item.reactionEmojis).some(url => typeof url !== 'string' || !/^https?:\/\//.test(url))) throw new Error('Invalid reaction emoji');
		if (![null, 'likeOnly', 'likeOnlyForRemote', 'nonSensitiveOnly', 'nonSensitiveOnlyForLocalLikeOnlyForRemote'].includes(item.reactionAcceptance)) throw new Error('Invalid reaction policy');
		if (input.mode === 'list' && (!Array.isArray(item.rows) || item.rows.length > (input.limit ?? 10))) throw new Error('Invalid reaction list');
		const ids = new Set<string>();
		for (const row of item.rows ?? []) {
			if (row.origin !== peerOrigin || !gridspaceNoteId(row.id) || !Number.isSafeInteger(row.time) || row.time < 0 || typeof row.reaction !== 'string' || row.reaction.length > 260 || typeof row.userUri !== 'string' || !/^https?:\/\//.test(row.userUri)) throw new Error('Invalid reactor');
			if (ids.has(row.id)) throw new Error('Duplicate reactor');
			ids.add(row.id);
		}
	}
	return value as ReactionSnapshot[];
}
