/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { webcrypto } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { mergeGridspacePalette, snapshotGridspacePalette, snapshotGridspacePaletteForAccount } from '@/utility/gridspace-palette.js';
import type { GridspacePaletteSnapshot } from '@/utility/gridspace-palette.js';
import type { PreferencesProfile } from '@/preferences/manager.js';

afterEach(() => vi.unstubAllGlobals());
const source: GridspacePaletteSnapshot = { version: 1, palettes: [
	{ id: 'one', name: 'よく使う', emojis: ['😀', ':resonite:'] },
	{ id: 'two', name: 'リアクション', emojis: [':remote@example.net:', ':resonite:'] },
], forMain: null, forReaction: 'two' };

test('reads the selected account’s synced palettes instead of the active account’s shared cache', async () => {
	const profile = { preferences: {
		emojiPalettes: [[{ server: 'r.example' }, [{ id: 'account-a', name: 'A only', emojis: ['😺'] }], { sync: true }]],
		emojiPaletteForMain: [[{}, 'account-a', { sync: true }]],
		emojiPaletteForReaction: [[{}, 'account-a', { sync: true }]],
	} } as unknown as PreferencesProfile;
	const load = vi.fn(async (key: string) => ({ value: key === 'emojiPalettes' ? source.palettes : key === 'emojiPaletteForReaction' ? 'two' : null }));
	expect(await snapshotGridspacePaletteForAccount(profile, 'r.example', 'account-b', 'account-a', load)).toEqual(source);
	expect(load).toHaveBeenCalledTimes(3);
	expect(profile.preferences.emojiPalettes[0][1][0].id).toBe('account-a');
	const missing = await snapshotGridspacePaletteForAccount(profile, 'r.example', 'account-b', 'account-a', async () => null);
	expect(missing.palettes).toEqual([]);
	await expect(snapshotGridspacePaletteForAccount(profile, 'r.example', 'account-b', 'account-a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
});

test('exports the account selected for OAuth without taking another account’s preferences', () => {
	const profile = { preferences: {
		emojiPalettes: [[{ server: 'r.example', account: 'other' }, [{ id: 'private', name: '', emojis: [] }], {}], [{ server: 'r.example' }, source.palettes, {}]],
		emojiPaletteForMain: [[{}, null, {}]],
		emojiPaletteForReaction: [[{ server: 'r.example', account: 'selected' }, 'two', {}], [{}, null, {}]],
	} } as unknown as PreferencesProfile;
	expect(snapshotGridspacePalette(profile, 'r.example', 'selected')).toEqual(source);
});

test('keeps destination palettes and copies order, custom emoji names and effective selections', async () => {
	vi.stubGlobal('crypto', webcrypto);
	const existing = [{ id: 'mine', name: 'ぐりすぺ', emojis: ['😺'] }];
	const result = await mergeGridspacePalette(existing, source, 'https://r.example', 'user');
	expect(result.palettes[0]).toEqual(existing[0]);
	expect(result.palettes.slice(1).map(({ name, emojis }) => ({ name, emojis }))).toEqual(source.palettes.map(({ name, emojis }) => ({ name, emojis })));
	expect(result.forMain).toBe(result.palettes[1].id);
	expect(result.forReaction).toBe(result.palettes[2].id);
});

test('retrying does not duplicate palettes or overwrite edits made after import', async () => {
	vi.stubGlobal('crypto', webcrypto);
	const first = await mergeGridspacePalette([], source, 'https://r.example', 'user');
	first.palettes[0].emojis = ['😺'];
	const second = await mergeGridspacePalette(first.palettes, source, 'https://r.example', 'user');
	expect(second.palettes).toEqual(first.palettes);
	const other = await mergeGridspacePalette(first.palettes, source, 'https://r.example', 'other');
	expect(other.palettes).toHaveLength(4);
});
