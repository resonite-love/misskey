/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type LinkedList = { id: string; name: string; isPublic: boolean; members: { uri: string; withReplies: boolean }[] };

export type LinkedAntenna = {
	id: string; name: string; src: 'home' | 'all' | 'users' | 'list' | 'users_blacklist'; userListId: string | null;
	users: string[]; keywords: string[][]; excludeKeywords: string[][]; expression: string | null;
	caseSensitive: boolean; localOnly: boolean; excludeBots: boolean; withReplies: boolean; withFile: boolean; excludeNotesInSensitiveChannel: boolean;
};

export function parseLinkedAntennas(value: unknown): LinkedAntenna[] {
	if (!Array.isArray(value) || value.length > 1000 || JSON.stringify(value).length > 512000) throw new Error('Invalid antennas');
	const ids = new Set<string>();
	const strings = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 1000 && items.every(item => typeof item === 'string' && item.length <= 1024);
	const words = (items: unknown): items is string[][] => Array.isArray(items) && items.length <= 1000 && items.every(strings);
	return value.map((item: LinkedAntenna) => {
		if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(item.id) || ids.has(item.id) ||
			typeof item.name !== 'string' || !item.name.length || item.name.length > 128 ||
			!['home', 'all', 'users', 'list', 'users_blacklist'].includes(item.src) ||
			(item.userListId !== null && (typeof item.userListId !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(item.userListId))) ||
			!strings(item.users) || !words(item.keywords) || !words(item.excludeKeywords) ||
			(item.expression !== null && (typeof item.expression !== 'string' || item.expression.length > 2048)) ||
			['caseSensitive', 'localOnly', 'excludeBots', 'withReplies', 'withFile', 'excludeNotesInSensitiveChannel'].some(key => typeof item[key as keyof LinkedAntenna] !== 'boolean')) throw new Error('Invalid antenna');
		ids.add(item.id);
		return { id: item.id, name: item.name, src: item.src, userListId: item.userListId, users: [...item.users], keywords: item.keywords.map(row => [...row]), excludeKeywords: item.excludeKeywords.map(row => [...row]), expression: item.expression,
			caseSensitive: item.caseSensitive, localOnly: item.localOnly, excludeBots: item.excludeBots, withReplies: item.withReplies, withFile: item.withFile, excludeNotesInSensitiveChannel: item.excludeNotesInSensitiveChannel };
	});
}

/** A bare account name belongs to the source server, not to the destination. */
export function migrateAntennaUsers(users: string[], sourceOrigin: string, destinationOrigin: string): string[] {
	return users.map(value => {
		const account = value.replace(/^@/, '');
		const [username, host] = account.split('@');
		if (!username || account.split('@').length > 2) throw new Error('Invalid antenna user');
		const originHost = host || new URL(sourceOrigin).host;
		return originHost.toLowerCase() === new URL(destinationOrigin).host.toLowerCase() ? username : `${username}@${originHost}`;
	});
}

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
