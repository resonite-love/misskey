/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { entities } from 'misskey-js';
import { url } from '@@/js/config.js';
import { applyNoteViewPlugins } from '@/utility/note-view-plugins.js';

type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];

/** This normal-shaped note is ephemeral and never enters a normal API or cache. */
export function applyGridspaceNoteViewPlugins(note: PrivateNote): PrivateNote | null {
	const localPrefix = `${url}/users/`;
	const localAuthor = note.author.uri.startsWith(localPrefix);
	const userId = localAuthor ? note.author.uri.slice(localPrefix.length) : note.author.uri;
	const result = applyNoteViewPlugins({
		...note,
		visibility: note.visibility as entities.Note['visibility'],
		userId,
		user: {
			...note.author, id: userId, host: localAuthor ? null : note.author.host, avatarBlurhash: note.author.avatarBlurhash ?? null,
			avatarDecorations: note.author.avatarDecorations ?? [], isBot: note.author.isBot ?? false,
			isCat: note.author.isCat ?? false, onlineStatus: 'unknown', emojis: note.author.emojis ?? {},
			instance: undefined,
		},
		channel: note.channel ? { ...note.channel, isSensitive: false, allowRenoteToExternal: false, userId: null } : null,
		fileIds: note.files.map(file => file.id),
		files: note.files.map(file => ({
			...file, createdAt: note.createdAt, url: '', thumbnailUrl: null, properties: {}, blurhash: null,
			md5: '', userId: null, user: null, folderId: null, folder: null,
		})),
		poll: note.poll ? { ...note.poll, choices: note.poll.choices.map(choice => ({ ...choice, isVoted: choice.isVoted === true })) } : null,
		renote: undefined,
		reactionAcceptance: null, reactions: note.reactions ?? {}, reactionEmojis: note.reactionEmojis ?? {},
		reactionCount: Object.values(note.reactions ?? {}).reduce((sum, count) => sum + count, 0),
		renoteCount: 0, repliesCount: 0,
	});
	if (!result) return null;
	// Display changes must never replace the peer IDs, origin, permissions or
	// file access descriptors used by delegated actions and authorization checks.
	return {
		...note, text: result.text, cw: result.cw ?? null, emojis: result.emojis ?? {},
		author: { ...note.author, name: result.user.name, emojis: result.user.emojis, isCat: result.user.isCat },
	};
}
