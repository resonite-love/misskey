/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type ConversationNote = {
	id: string;
	uri: string;
	conversationUri?: string;
	multiNoteKind?: string;
	includeDefault?: boolean | null;
	channelId?: string | null;
};

export function conversationTarget(note: ConversationNote) {
	const conversationUri = note.includeDefault === true ? undefined : note.conversationUri ?? (note.multiNoteKind && note.includeDefault === false ? note.uri : undefined);
	return conversationUri ? { noteId: note.id, conversationUri } : { noteId: note.id, channelId: note.channelId ?? undefined };
}

export function gridspaceDetailPath(note: ConversationNote, id = note.id): string {
	const target = conversationTarget(note);
	const params = new URLSearchParams({ noteId: id });
	if (target.conversationUri) {
		params.set('conversationUri', id === note.id ? target.conversationUri : new URL(`/notes/${encodeURIComponent(id)}`, target.conversationUri).href);
	} else if (target.channelId) {
		params.set('channelId', target.channelId);
	}
	return `/gridspace/private?${params}`;
}
