/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const profileFields = ['name', 'description', 'location', 'birthday', 'fields', 'avatarId', 'bannerId'] as const;
export type ProfileField = typeof profileFields[number];
export type LinkedProfile = {
	name: string | null; description: string | null; location: string | null; birthday: string | null;
	fields: { name: string; value: string }[];
	avatarUrl: string | null; bannerUrl: string | null;
};

/** Deliberately exclude credentials, privacy settings and server-specific IDs. */
export function parseLinkedProfile(input: unknown): LinkedProfile {
	if (!input || typeof input !== 'object') throw new Error('Invalid profile');
	const p = input as Record<string, unknown>;
	for (const [key, max] of [['name', 50], ['description', 1500], ['location', 50], ['birthday', 10], ['avatarUrl', 4096], ['bannerUrl', 4096]] as const) {
		if (p[key] !== null && (typeof p[key] !== 'string' || p[key].length > max)) throw new Error('Invalid profile');
	}
	if (p.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(p.birthday as string)) throw new Error('Invalid birthday');
	for (const key of ['avatarUrl', 'bannerUrl']) if (p[key]) {
		const url = new URL(p[key] as string);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid profile image');
	}
	if (!Array.isArray(p.fields) || p.fields.length > 16 || p.fields.some(f => !f || typeof f.name !== 'string' || typeof f.value !== 'string')) throw new Error('Invalid fields');
	return { name: p.name as string | null, description: p.description as string | null, location: p.location as string | null, birthday: p.birthday as string | null,
		fields: p.fields.map(f => ({ name: f.name, value: f.value })), avatarUrl: p.avatarUrl as string | null, bannerUrl: p.bannerUrl as string | null };
}

export function profileValueIsEmpty(value: unknown): boolean {
	return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}
