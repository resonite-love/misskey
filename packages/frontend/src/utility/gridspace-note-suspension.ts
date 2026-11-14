/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import { checkTextWordMute } from '@/utility/check-word-mute.js';
import { $i } from '@/i.js';

export type GridspacePrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];
export type GridspaceNoteReference = Pick<GridspacePrivateNote, 'id' | 'uri' | 'createdAt' | 'collectionAt'> & { suspended: true; visible: boolean };
export type GridspaceNoteEntry = GridspacePrivateNote | GridspaceNoteReference;

export function isRevokedGridspaceRead(error: unknown): boolean {
	const reason = (error as { info?: { reason?: string } } | null)?.info?.reason;
	return reason === 'AUTHORIZATION_REVOKED' || reason === 'LINK_REVOKED';
}

export function isSuspendedNote(note: GridspaceNoteEntry): note is GridspaceNoteReference {
	return 'suspended' in note;
}

export function isVisiblePrivateNote(note: GridspaceNoteEntry, withSensitive = true): boolean {
	if (isSuspendedNote(note)) return note.visible;
	return [note, ...(note.renote ? [note.renote] : [])].every(part =>
		(withSensitive || !part.files.some(file => file.isSensitive)) && (!$i || !checkTextWordMute(`${part.cw ?? ''}\n${part.text ?? ''}`, $i.hardMutedWords)),
	);
}

/** Retain only ordering/authorization references, never bodies, actors or files. */
export function suspendPrivateNotes(notes: GridspaceNoteEntry[], withSensitive = true): GridspaceNoteReference[] {
	return notes.map(note => ({ id: note.id, uri: note.uri, createdAt: note.createdAt, ...(note.collectionAt ? { collectionAt: note.collectionAt } : {}), suspended: true, visible: isVisiblePrivateNote(note, withSensitive) }));
}

/** Vue's leave phase can outlive authorization (including throttled hidden tabs). */
export function clearLeavingPrivateNote(element: Element): void {
	if (element.hasAttribute('data-gridspace-private-row')) element.replaceChildren();
}
