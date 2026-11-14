/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { mapLayoutSettings, validLayoutSetting } from '@/utility/gridspace-layout.js';
import { parseClientSettings } from '@/utility/gridspace-settings.js';

const profile = { id: 'profile1', name: 'Work', columns: [
	{ id: 'col1', type: 'list', name: 'friends', width: 330, listId: 'list1' },
	{ id: 'col2', type: 'antenna', name: null, width: 300, antennaId: 'antenna1' },
], layout: [['col1', 'col2']] };
describe('layout migration', () => {
	test('retains column order, widths and stacked layout while mapping source IDs', async () => {
		const result = await mapLayoutSettings({ 'deck.profiles': [profile], 'deck.profile': 'Work', uploadFolder: 'folder1' }, async (kind, id) => ({ id: `${kind}-${id}` }), 'unavailable');
		expect(result.issues).toEqual([]);
		expect(result.values['deck.profiles'][0]).toMatchObject({ layout: [['col1', 'col2']], columns: [{ width: 330, listId: 'list-list1' }, { antennaId: 'antenna-antenna1' }] });
		expect(result.values.uploadFolder).toBe('folder-folder1');
		expect(profile.columns[0].listId).toBe('list1');
	});
	test('deduplicates reference requests and keeps script apps stopped after import', async () => {
		const resolve = vi.fn(async () => ({ id: 'mapped' }));
		const result = await mapLayoutSettings({ uploadFolder: 'folder1', widgets: [{ name: 'slideshow', data: { folderId: 'folder1' } }, { name: 'aiscriptApp', data: { script: '1+1' } }] }, resolve, 'notice');
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(result.values.widgets[1].data).toEqual({ script: '1+1', runAutomatically: false });
	});
	test('preserves failed columns as a warning rather than binding a colliding local ID', async () => {
		const result = await mapLayoutSettings({ 'deck.profiles': [profile], uploadFolder: 'gone' }, async () => { throw new Error('deleted'); }, 'notice');
		expect(result.values.uploadFolder).toBeUndefined();
		expect(result.values['deck.profiles'][0].columns[0].gridspaceImportError).toBe('notice');
		expect(result.issues).toHaveLength(3);
	});
	test('rejects broken layouts and prototype keys', () => {
		expect(validLayoutSetting('deck.profiles', [profile])).toBe(true);
		expect(validLayoutSetting('deck.profiles', [{ ...profile, layout: [['missing']] }])).toBe(false);
		expect(validLayoutSetting('widgets', JSON.parse('[{"id":"a","name":"clock","data":{"__proto__":{}}}]'))).toBe(false);
	});
	test('accepts newly exported layouts while keeping plugins outside the allowlist', () => {
		const parsed = parseClientSettings(JSON.stringify({ version: 1, values: { 'deck.profiles': [profile], plugins: ['ignored'], uploadFolder: 'folder1' }, memos: { memo: 'remember', memo2: null } }));
		expect(parsed.values).not.toHaveProperty('plugins');
		expect(parsed.memos?.memo).toBe('remember');
		expect(parsed.values.uploadFolder).toBe('folder1');
	});
});
