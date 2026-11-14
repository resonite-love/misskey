/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import type { GridspaceSharedDriveService } from '@/core/gridspace/GridspaceSharedDriveService.js';
import type { GridspaceManagedResourceService } from '@/core/gridspace/GridspaceManagedResourceService.js';
import type { GridspaceChannelService } from '@/core/gridspace/GridspaceChannelService.js';
import type { RegistryApiService } from '@/core/RegistryApiService.js';
import Endpoint from './layout-reference.js';

function fixture() {
	const links = mockDeep<GridspaceLinkService>(), drive = mockDeep<GridspaceSharedDriveService>(), registry = mockDeep<RegistryApiService>(), db = mockDeep<DataSource>();
	const binding = { peerOrigin: 'https://r.example', peerUserId: 'source' } as Awaited<ReturnType<GridspaceLinkService['checkSettingsAuthorization']>>;
	links.checkSettingsAuthorization.mockResolvedValue(binding);
	drive.referenceFolder.mockResolvedValue({ id: 'localFolder', name: 'Uploads' } as never);
	registry.getItem.mockResolvedValue({ value: { lists: [{ source: { id: 'sourceList' }, targetId: 'localList', state: 'done' }] } } as never);
	const lists = { findOneBy: async (where: { id: string; userId: string }) => where.id === 'localList' && where.userId === 'viewer' ? { id: 'localList', name: 'Friends' } : null };
	db.getRepository.mockReturnValue(lists as never);
	const endpoint = new Endpoint(links, drive, mockDeep<GridspaceManagedResourceService>(), mockDeep<GridspaceChannelService>(), registry, db);
	const call = (kind: string, id: string) => endpoint.exec({ kind, id }, { id: 'viewer' } as MiLocalUser, null);
	return { call, links, binding, registry, drive };
}

describe('layout reference authorization', () => {
	test('resolves a shared upload folder and a completed owned list copy', async () => {
		const f = fixture();
		expect(await f.call('folder', 'sourceFolder')).toEqual({ id: 'localFolder', name: 'Uploads' });
		expect(await f.call('list', 'sourceList')).toEqual({ id: 'localList', name: 'Friends' });
	});
	test('does not accept arbitrary list IDs or a receipt pointing to another owner', async () => {
		const f = fixture();
		await expect(f.call('list', 'localList')).rejects.toMatchObject({ code: 'GRIDSPACE_LAYOUT_UNAVAILABLE' });
		f.registry.getItem.mockResolvedValue({ value: { lists: [{ source: { id: 'sourceList' }, targetId: 'foreignList', state: 'done' }] } } as never);
		await expect(f.call('list', 'sourceList')).rejects.toMatchObject({ code: 'GRIDSPACE_LAYOUT_UNAVAILABLE' });
	});
	test('rejects a reference if the authorization changes while resolving', async () => {
		const f = fixture();
		f.links.checkSettingsAuthorization.mockResolvedValueOnce(f.binding).mockRejectedValueOnce(new Error('revoked'));
		await expect(f.call('folder', 'sourceFolder')).rejects.toMatchObject({ code: 'GRIDSPACE_LAYOUT_UNAVAILABLE' });
	});
	test('rejects arbitrary URL references before resolving them', async () => {
		const f = fixture();
		await expect(f.call('file', 'https://other.example/file')).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(f.drive.referenceFolder).not.toHaveBeenCalled();
	});
});
