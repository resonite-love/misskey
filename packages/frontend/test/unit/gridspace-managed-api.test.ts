/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { routeManagedApi, sharedAntennaUnavailable } from '@/utility/gridspace-managed-api.js';

describe('shared resource API adapter', () => {
	test('routes shared clip membership and preserves the duplicate confirmation', async () => {
		const call = vi.fn().mockResolvedValue({ item: null, clipNoteError: 'already-added' });
		await expect(routeManagedApi('clips/add-note', { clipId: 'gridspace:clip:clip1', noteId: 'native', i: 'secret' }, call)).rejects.toMatchObject({ code: 'ALREADY_CLIPPED' });
		expect(call).toHaveBeenCalledWith('gridspace/managed-resource', { kind: 'clip', action: 'add-note', id: 'clip1', data: { noteId: 'native' } });
	});
	test('keeps ordinary APIs and mismatched resource IDs on their native path', () => {
		const call = vi.fn();
		expect(routeManagedApi('pages/update', { pageId: 'native1' }, call)).toBeUndefined();
		expect(routeManagedApi('pages/delete', { pageId: 'gridspace:clip:clip1' }, call)).toBeUndefined();
		expect(call).not.toHaveBeenCalled();
	});
	test('routes only the original target and changes, without forwarding browser credentials', async () => {
		const call = vi.fn().mockResolvedValue({ item: { id: 'gridspace:page:original1', title: 'updated' } });
		expect(await routeManagedApi('pages/update', { pageId: 'gridspace:page:original1', title: 'updated', i: 'browser-token' }, call)).toMatchObject({ title: 'updated' });
		expect(call).toHaveBeenCalledWith('gridspace/managed-resource', { kind: 'page', action: 'update', id: 'original1', data: { title: 'updated' } });
	});
	test('replaces a previous antenna copy with the one shared original', async () => {
		const call = vi.fn(async path => path === 'antennas/list' ? [{ id: 'copy1' }, { id: 'native1' }] : { enabled: true, items: [{ id: 'gridspace:antenna:original1' }], aliases: [{ targetId: 'copy1' }] });
		expect(await routeManagedApi('antennas/list', {}, call)).toEqual([{ id: 'native1' }, { id: 'gridspace:antenna:original1' }]);
		expect(sharedAntennaUnavailable.value).toBe(false);
	});
	test('keeps local antennas usable while the paired server is offline', async () => {
		const call = vi.fn(async path => { if (path === 'antennas/list') return [{ id: 'native1' }]; throw new Error('offline'); });
		expect(await routeManagedApi('antennas/list', {}, call)).toEqual([{ id: 'native1' }]);
		expect(sharedAntennaUnavailable.value).toBe(true);
	});
});

test.each(['favorite', 'unfavorite'])('routes shared clip %s without sending source IDs to the local API', async action => {
 const call = vi.fn().mockResolvedValue({ item: { isFavorited: action === 'favorite' } });
 await routeManagedApi('clips/' + action, { clipId: 'gridspace:clip:original', i: 'secret' }, call);
 expect(call).toHaveBeenCalledWith('gridspace/managed-resource', { kind: 'clip', action, id: 'original', data: {} });
 expect(routeManagedApi('clips/' + action, { clipId: 'local' }, call)).toBeUndefined();
});
