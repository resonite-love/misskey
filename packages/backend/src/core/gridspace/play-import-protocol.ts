/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type LinkedPlay = { id: string; title: string; summary: string; script: string; permissions: string[]; visibility: 'public' | 'private' };
export type LinkedPlayIndex = Pick<LinkedPlay, 'id' | 'title'>;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(value);

export function parseLinkedPlayIndex(value: unknown): LinkedPlayIndex[] {
	if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid Play index');
	const ids = new Set<string>();
	return value.map(item => {
		if (!item || !validId(item.id) || ids.has(item.id) || typeof item.title !== 'string' || item.title.length > 256) throw new Error('Invalid Play index');
		ids.add(item.id);
		return { id: item.id, title: item.title };
	});
}

export function parseLinkedPlay(value: unknown): LinkedPlay {
	const play = value as LinkedPlay | null;
	if (!play || !validId(play.id) || typeof play.title !== 'string' || play.title.length > 256 || typeof play.summary !== 'string' || play.summary.length > 1024 ||
		typeof play.script !== 'string' || play.script.length > 65536 || !['public', 'private'].includes(play.visibility) ||
		!Array.isArray(play.permissions) || play.permissions.length > 256 || play.permissions.some(permission => typeof permission !== 'string' || permission.length > 256)) throw new Error('Invalid Play');
	return { id: play.id, title: play.title, summary: play.summary, script: play.script, permissions: [...play.permissions], visibility: play.visibility };
}
