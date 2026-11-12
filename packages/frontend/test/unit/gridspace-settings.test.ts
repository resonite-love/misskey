/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { parseClientSettings, snapshotClientSettings } from '@/utility/gridspace-settings.js';
import type { PreferencesProfile } from '@/preferences/manager.js';

test('copies disabled sounds and posting defaults but excludes plugins and server-local IDs', () => {
	const parsed = parseClientSettings(JSON.stringify({ version: 1, visibility: 'followers', localOnly: true, values: {
		'sound.on.notification': { type: null, volume: 0 }, defaultNoteVisibility: 'home', defaultNoteLocalOnly: true,
		plugins: [{ code: 'never transfer scripts' }], uploadFolder: 'old-id', 'deck.profiles': [{ id: 'old-list' }], accounts: ['private'],
	} }));
	expect(parsed.values).toEqual({ 'sound.on.notification': { type: null, volume: 0 }, defaultNoteVisibility: 'home', defaultNoteLocalOnly: true });
});

test('reads the selected account cloud value and never copies another active account shared cache', async () => {
	const profile = { preferences: {
		defaultNoteVisibility: [[{}, 'public', { sync: true }]], animation: [[{}, false, {}]],
		defaultNoteLocalOnly: [[{ server: 'r.example', account: 'selected' }, true, {}]],
	} } as unknown as PreferencesProfile;
	const load = vi.fn(async () => ({ value: 'followers' }));
	const parsed = parseClientSettings(await snapshotClientSettings(profile, 'r.example', 'selected', 'other', load, { visibility: 'public', localOnly: false }));
	expect(parsed.values).toEqual({ defaultNoteVisibility: 'followers', defaultNoteLocalOnly: true });
	expect(parsed.visibility).toBe('followers'); expect(parsed.localOnly).toBe(true);
	expect(load).toHaveBeenCalledTimes(1);
});

test('preserves active account remembered visibility and skips drive-backed sounds', async () => {
	const profile = { preferences: { 'sound.on.note': [[{}, { type: '_driveFile_', fileId: 'private-id', volume: 1 }, {}]], 'sound.on.notification': [[{}, { type: null, volume: 0 }, {}]] } } as unknown as PreferencesProfile;
	const parsed = parseClientSettings(await snapshotClientSettings(profile, 'r.example', 'selected', 'selected', async () => null, { visibility: 'home', localOnly: true }));
	expect(parsed.visibility).toBe('home'); expect(parsed.localOnly).toBe(true);
	expect(parsed.values).toEqual({ 'sound.on.notification': { type: null, volume: 0 } });
});

test('rejects invalid visibility and volume without silently broadening audience', () => {
	for (const values of [{ defaultNoteVisibility: 'everyone' }, { 'sound.on.note': { type: null, volume: -1 } }]) {
		expect(() => parseClientSettings(JSON.stringify({ version: 1, visibility: 'followers', localOnly: false, values }))).toThrow();
	}
});

test('unknown preferences of another selected account never invent public posting defaults', async () => {
	const profile = { preferences: { defaultNoteVisibility: [[{}, 'public', {}]], defaultNoteLocalOnly: [[{}, false, {}]] } } as unknown as PreferencesProfile;
	const parsed = parseClientSettings(await snapshotClientSettings(profile, 'r.example', 'selected', 'other', async () => null, { visibility: 'public', localOnly: false }));
		expect(parsed.values).toEqual({}); expect(parsed.visibility).toBeUndefined(); expect(parsed.localOnly).toBeUndefined();
});
