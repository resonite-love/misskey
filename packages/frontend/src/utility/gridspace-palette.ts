/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { PreferencesProfile } from '@/preferences/manager.js';

export type GridspacePaletteSnapshot = {
	version: 1;
	palettes: { id: string; name: string; emojis: string[] }[];
	forMain: string | null;
	forReaction: string | null;
};

type PaletteKey = 'emojiPalettes' | 'emojiPaletteForMain' | 'emojiPaletteForReaction';
type PaletteScope = PreferencesProfile['preferences']['emojiPalettes'][number][0];

/** Read synced values with the account chosen for consent, not the active tab's account. */
export async function snapshotGridspacePaletteForAccount(
	profile: PreferencesProfile, server: string, account: string, localAccount: string | undefined,
	load: (key: PaletteKey, scope: PaletteScope) => Promise<{ value: unknown } | null>,
): Promise<GridspacePaletteSnapshot> {
	const preferences = {} as PreferencesProfile['preferences'];
	await Promise.all((['emojiPalettes', 'emojiPaletteForMain', 'emojiPaletteForReaction'] as const).map(async key => {
		const records = profile.preferences[key];
		const record = records.find(([scope]) => scope.server === server && scope.account === account) ??
			records.find(([scope]) => scope.server === server && scope.account == null) ??
			records.find(([scope]) => scope.server == null && scope.account == null);
		if (!record) throw new Error('Missing palette preference');
		let value: unknown = JSON.parse(JSON.stringify(record[1]));
		if (record[2].sync) {
			const remote = await load(key, record[0]);
			// A shared record may hold the other account's last cloud fetch.
			value = remote ? remote.value : (localAccount === account || record[0].account === account) ? value : key === 'emojiPalettes' ? [] : null;
		}
		Object.assign(preferences, { [key]: [[{ server, account }, value, {}]] });
	}));
	return snapshotGridspacePalette({ ...profile, preferences }, server, account);
}

/** Match the account selected in the consent form, which may differ from the current account. */
export function snapshotGridspacePalette(profile: PreferencesProfile, server: string, account: string): GridspacePaletteSnapshot {
	function read<K extends 'emojiPalettes' | 'emojiPaletteForMain' | 'emojiPaletteForReaction'>(key: K) {
		const records = profile.preferences[key];
		const record = records.find(([scope]) => scope.server === server && scope.account === account) ??
			records.find(([scope]) => scope.server === server && scope.account == null) ??
			records.find(([scope]) => scope.server == null && scope.account == null);
		if (!record) throw new Error('Missing palette preference');
		return record[1];
	}

	const palettes = (read('emojiPalettes') as GridspacePaletteSnapshot['palettes']).map(palette => ({ ...palette, emojis: [...palette.emojis] }));
	const main = read('emojiPaletteForMain') as string | null;
	const reaction = read('emojiPaletteForReaction') as string | null;
	return {
		version: 1, palettes,
		forMain: palettes.some(p => p.id === main) ? main : null,
		forReaction: palettes.some(p => p.id === reaction) ? reaction : null,
	};
}

export function gridspacePaletteSource(origin: string, userId: string): string {
	return JSON.stringify([origin, userId]);
}

/** Stable IDs make retries harmless and preserve changes to palettes already imported. */
export async function mergeGridspacePalette(current: GridspacePaletteSnapshot['palettes'], source: Omit<GridspacePaletteSnapshot, 'version'>, origin: string, userId: string) {
	const ids = new Map<string, string>();
	const palettes = current.map(palette => ({ ...palette, emojis: [...palette.emojis] }));
	for (const palette of source.palettes) {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([origin, userId, palette.id])));
		const id = 'gridspace-' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('').slice(0, 32);
		ids.set(palette.id, id);
		if (!palettes.some(p => p.id === id)) palettes.push({ ...palette, id, emojis: [...palette.emojis] });
	}
	const first = source.palettes[0]?.id ?? '';
	return {
		palettes,
		forMain: ids.get(source.forMain ?? first) ?? null,
		forReaction: ids.get(source.forReaction ?? first) ?? null,
	};
}
