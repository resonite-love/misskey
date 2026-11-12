/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type LinkedList = { id: string; name: string; isPublic: boolean; members: { uri: string; withReplies: boolean }[] };

export function parseLinkedLists(value: unknown): LinkedList[] {
	if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid lists');
	let members = 0;
	const ids = new Set<string>();
	return value.map(list => {
		if (!list || typeof list.id !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(list.id) || ids.has(list.id) ||
			typeof list.name !== 'string' || list.name.length < 1 || list.name.length > 128 || typeof list.isPublic !== 'boolean' || !Array.isArray(list.members)) throw new Error('Invalid list');
		ids.add(list.id);
		members += list.members.length;
		if (members > 10000) throw new Error('Too many members');
		return { id: list.id, name: list.name, isPublic: list.isPublic, members: list.members.map((member: { uri: unknown; withReplies: unknown }) => {
			if (typeof member.uri !== 'string' || member.uri.length > 512 || typeof member.withReplies !== 'boolean') throw new Error('Invalid member');
			const uri = new URL(member.uri);
			if (!['https:', 'http:'].includes(uri.protocol) || uri.username || uri.password || uri.hash) throw new Error('Invalid actor URI');
			return { uri: member.uri, withReplies: member.withReplies };
		}) };
	});
}
