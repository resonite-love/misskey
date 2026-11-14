/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { parseClientSettings, snapshotClientSettings, importedSettingKeys } from '@/utility/gridspace-settings.js';
import type { PreferencesProfile } from '@/preferences/manager.js';

test('keeps the destination translation opt-in/out when importing source settings', () => {
	expect(importedSettingKeys).not.toContain('autoTranslation.enabled');
	expect(importedSettingKeys).toContain('autoTranslation.targetLang');
});

test('copies disabled sounds and posting defaults but excludes plugins and credentials', () => {
	const parsed = parseClientSettings(JSON.stringify({ version: 1, visibility: 'followers', localOnly: true, values: {
		'sound.on.notification': { type: null, volume: 0 }, defaultNoteVisibility: 'home', defaultNoteLocalOnly: true,
		plugins: [{ code: 'never transfer scripts' }], accounts: ['private'],
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

// Native snapshots may outlive the client version that originally wrote them.
test('exports legacy data saver flags without blocking OAuth', async () => {
 const profile = { preferences: { dataSaver: [[{}, { media: true, avatar: false, urlPreviewThumbnail: true, disableUrlPreview: false }, {}]] } } as unknown as PreferencesProfile;
 const parsed = parseClientSettings(await snapshotClientSettings(profile, 'r.example', 'selected', 'selected', async() => null, { visibility: 'followers', localOnly: true }));
 expect(parsed.values.dataSaver).toEqual({ media: true, avatar: false, urlPreviewThumbnail: true, disableUrlPreview: false, code: false });
 expect(parsed.skipped).toBeUndefined();
});
test('reports unusable optional settings but still exports valid settings', async () => {
 const profile = { preferences: { animation: [[{}, false, {}]], 'deck.profiles': [[{}, [{ columns: [], layout: [] }], {}]] } } as unknown as PreferencesProfile;
 const parsed = parseClientSettings(await snapshotClientSettings(profile, 'r.example', 'selected', 'selected', async() => null, { visibility: 'followers', localOnly: true }));
 expect(parsed.values).toEqual({ animation: false });
 expect(parsed.skipped).toEqual(['deck.profiles']);
 expect(parsed.visibility).toBe('followers');
});
test('does not silently discard invalid posting privacy or cloud failures', async () => {
 const invalid = { preferences: { defaultNoteVisibility: [[{}, 'invalid', {}]] } } as unknown as PreferencesProfile;
 await expect(snapshotClientSettings(invalid, 'r.example', 'selected', 'selected', async() => null, { visibility: 'followers', localOnly: true })).rejects.toThrow();
 const synced = { preferences: { animation: [[{}, false, { sync: true }]] } } as unknown as PreferencesProfile;
 await expect(snapshotClientSettings(synced, 'r.example', 'selected', 'selected', async() => {throw new Error('offline');}, { visibility: 'followers', localOnly: true })).rejects.toThrow('offline');
});

test('exports menu order, sidebar mode, statusbars, pins and image preferences', async () => {
	const label = { enabled: true, scale: 1, padding: 0.2, textBig: '{year}', textSmall: '', centered: false, withQrCode: true };
	const values = {
		menu: ['notifications', '-', 'clips', 'drive'], mutingEmojis: [':hide:', '😺'],
		statusbars: [{ id: 'bar1', name: 'News', type: 'rss', size: 'small', black: false, props: { url: 'https://news.example/rss', refreshIntervalSec: 120, display: 'marquee', marqueeDuration: 100, marqueeReverse: false, shuffle: true } }],
		pinnedUserLists: [{ id: 'list1', name: 'Friends' }], defaultImageCompressionLevel: 3, defaultVideoCompressionLevel: 1,
		watermarkPresets: [{ id: 'mark1', name: 'Copyright', layers: [{ id: 'layer1', type: 'text', text: '© author', repeat: false, noBoundingBoxExpansion: false, scale: 0.3, angle: 0, opacity: 0.75, align: { x: 'right', y: 'bottom' } }] }],
		defaultWatermarkPresetId: 'mark1',
		imageFramePresets: [{ id: 'frame1', name: 'Photo', params: { borderThickness: 0.05, borderRadius: 0, bgColor: [1, 1, 1], fgColor: [0, 0, 0], font: 'sans-serif', labelTop: label, labelBottom: label } }],
	};
	const profile = { preferences: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, [[{}, value, {}]]])) } as unknown as PreferencesProfile;
	const result = parseClientSettings(await snapshotClientSettings(profile, 'r.example', 'selected', 'selected', async () => null, { visibility: 'home', localOnly: false, menuDisplay: 'sideIcon' }));
	expect(result.values).toEqual(values);
	expect(result.menuDisplay).toBe('sideIcon');
});

test.each([
	{ menu: ['<script>'] }, { defaultVideoCompressionLevel: 99 }, { mutingEmojis: [42] },
	{ imageFramePresets: [{ id: 'frame', name: 'bad', params: {} }] },
	{ statusbars: [{ id: 'bar', name: null, type: 'code', size: 'small', black: false, props: {} }] },
	{ watermarkPresets: [{ id: 'preset', name: 'bad', layers: [{ id: 'layer', type: 'text' }] }] },
])('rejects invalid extended preferences without importing executable or broken state', values => {
	expect(() => parseClientSettings(JSON.stringify({ version: 1, values }))).toThrow();
});
