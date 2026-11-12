/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/Note.js';
import type { IPost } from '@/core/activitypub/type.js';

export const GRIDSPACE_NOTE_PATH = '/gridspace/v1/notes/';
export const GRIDSPACE_NOTE_BODY_LIMIT = 2 * 1024 * 1024;
export type GridspaceNoteEntry = { object: IPost; localOnly: boolean; reactionAcceptance: MiNote['reactionAcceptance'] };
export type GridspaceNoteBundle = { deleted: boolean; unavailable?: boolean; notes: GridspaceNoteEntry[] };

export function canShareGridspaceNote(note: { visibility: string; channelId: string | null }): boolean {
	return !note.channelId && (note.visibility === 'public' || note.visibility === 'home');
}

export function gridspaceNoteId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(value);
}

/** Misskey Announce uses /activity; inside this pair it names the original Renote. */
export function canonicalGridspaceNoteUri(uri: string, peerUrl?: string): string {
	if (!peerUrl) return uri;
	const prefix = new URL(peerUrl).origin + '/notes/';
	return uri.startsWith(prefix) && /^[a-zA-Z0-9]{1,32}\/activity$/.test(uri.slice(prefix.length)) ? uri.slice(0, -9) : uri;
}

export function gridspaceNoteUris(uri: string, peerUrl?: string): string[] {
	const canonical = canonicalGridspaceNoteUri(uri, peerUrl);
	if (!peerUrl) return [uri];
	const prefix = new URL(peerUrl).origin + '/notes/';
	return canonical.startsWith(prefix) && gridspaceNoteId(canonical.slice(prefix.length)) ? [canonical, canonical + '/activity'] : [uri];
}

/** Only the authenticated peer may supply its own public/home objects. */
export function validateGridspaceBundle(value: unknown, origin: string, rootId: string): GridspaceNoteBundle {
	const bundle = value as GridspaceNoteBundle | null;
	if (!bundle || typeof bundle.deleted !== 'boolean' || !Array.isArray(bundle.notes) || bundle.notes.length > 64) throw new Error('Invalid bundle');
	if (bundle.unavailable !== undefined && typeof bundle.unavailable !== 'boolean') throw new Error('Invalid availability');
	if (bundle.unavailable) {
		if (bundle.deleted || bundle.notes.length !== 0) throw new Error('Invalid unavailable note');
		return bundle;
	}
	if (bundle.deleted) {
		if (bundle.notes.length !== 0) throw new Error('Invalid deletion');
		return bundle;
	}
	if (bundle.notes.length !== 1) throw new Error('Expected one note');
	const seen = new Set<string>();
	for (const entry of bundle.notes) {
		const note = entry?.object;
		if (!note || !['Note', 'Question'].includes(note.type as string) || typeof entry.localOnly !== 'boolean') throw new Error('Invalid note');
		if (typeof note.id !== 'string' || !note.id.startsWith(origin + '/notes/') || !gridspaceNoteId(note.id.slice((origin + '/notes/').length)) || seen.has(note.id)) throw new Error('Invalid note origin');
		if (typeof note.attributedTo !== 'string' || !note.attributedTo.startsWith(origin + '/users/') || !gridspaceNoteId(note.attributedTo.slice((origin + '/users/').length))) throw new Error('Invalid actor origin');
		if (![note.to, note.cc].some(audience => Array.isArray(audience) && audience.includes('https://www.w3.org/ns/activitystreams#Public'))) throw new Error('Private note');
		if (![null, 'likeOnly', 'likeOnlyForRemote', 'nonSensitiveOnly', 'nonSensitiveOnlyForLocalLikeOnlyForRemote'].includes(entry.reactionAcceptance)) throw new Error('Invalid reaction policy');
		seen.add(note.id);
	}
	if (!seen.has(origin + '/notes/' + rootId) || bundle.notes.at(-1)?.object.id !== origin + '/notes/' + rootId) throw new Error('Missing root');
	return bundle;
}
