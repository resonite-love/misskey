/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/Note.js';
import { canonicalGridspaceNoteUri, gridspaceNoteId } from './note-protocol.js';

type Provenance = Pick<MiNote, 'localOnly' | 'uri' | 'channelId'> & Partial<Pick<MiNote, 'includeDefault' | 'multiNoteKind' | 'multiNoteRootId'>>;

export function dedicatedOriginal(note: Provenance): boolean {
	return note.uri == null && note.localOnly && note.channelId == null && note.includeDefault === false &&
		(note.multiNoteKind === 'root' || (note.multiNoteKind === 'conversation-reply' && !!note.multiNoteRootId));
}

export function originNoteId(uri: string, origin: string): string | null {
	const prefix = origin + '/notes/';
	const canonical = canonicalGridspaceNoteUri(uri, origin);
	const id = canonical.startsWith(prefix) ? canonical.slice(prefix.length) : null;
	return gridspaceNoteId(id) ? id : null;
}

export type ConversationOptions = { conversationUri?: string };
export type ConversationCredential = ConversationOptions & { placementActorId?: string };
export const conversationUriSchema = { type: 'string', minLength: 1, maxLength: 1024 } as const;
export const placementActorIdSchema = { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } as const;
