/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { DriveService } from '@/core/DriveService.js';
import type { RegistryApiService } from '@/core/RegistryApiService.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiAvatarDecoration } from '@/models/AvatarDecoration.js';
import type { RoleService } from '@/core/RoleService.js';
import type Update from '@/server/api/endpoints/i/update.js';
import ProfileImport from '@/server/api/endpoints/gridspace/profile-import.js';
import { GridspaceLinkError, type GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { parseLinkedProfile, type LinkedProfile } from './profile-protocol.js';

const original: LinkedProfile = { name: 'Old name', description: 'Old bio', location: 'Tokyo', birthday: '2000-01-02', fields: [{ name: 'Site', value: 'https://example.com' }], avatarUrl: 'https://cdn.example/avatar.png', bannerUrl: 'https://cdn.example/banner.png', avatarDecorations: [] };

function fixture() {
	const user = { id: 'viewer', name: null, avatarId: null, bannerId: null, avatarDecorations: [] } as unknown as MiLocalUser;
	const profile = { description: null, location: null, birthday: null, fields: [] } as Record<string, unknown>;
	const db = mockDeep<DataSource>();
	const definitions: MiAvatarDecoration[] = [];
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiAvatarDecoration ? { find: async () => definitions } : { findOneByOrFail: async () => entity === MiUser ? user : profile }) as DataSource['getRepository']);
	const links = mockDeep<GridspaceLinkService>();
	links.privateLink.mockResolvedValue({ id: 'link', generation: 1, tokenCipher: 'token', peerUserId: 'old', peerOrigin: 'https://r.example' } as never);
	links.profile.mockResolvedValue({ peerOrigin: 'https://r.example', peerUserId: 'old', profile: original });
	const guard = mockDeep<GridspaceFollowGuardService>();
	guard.runProfile.mockImplementation(async (_id, action) => action());
	const drive = mockDeep<DriveService>();
	drive.uploadFromUrl.mockImplementation(async ({ url }) => ({ id: url.includes('avatar') ? 'avatar' : 'banner', userId: user.id }) as never);
	const registry = mockDeep<RegistryApiService>(); let receipt: unknown;
	registry.getItem.mockImplementation(async () => receipt ? { value: receipt } as never : null);
	registry.set.mockImplementation(async (_id, _domain, _scope, _key, value) => { receipt = structuredClone(value); });
	const update = mockDeep<Update>();
	update.exec.mockImplementation(async patch => { Object.assign(user, patch); Object.assign(profile, patch); return {}; });
	const roles = mockDeep<RoleService>(); roles.getRoles.mockResolvedValue([]); roles.getUserRoles.mockResolvedValue([]);
	const endpoint = new ProfileImport(links, guard, db, drive, registry, update, roles);
	return { user, profile, links, drive, update, definitions, roles, call: () => endpoint.exec({}, user, null) };
}

describe('one-time linked profile import', () => {
	test('copies all seven fields, uses ordinary update and keeps completed fields after edits', async () => {
		const f = fixture();
		expect(await f.call()).toMatchObject({ complete: true, failed: [], skipped: ['avatarDecorations'] });
		expect(f.user.name).toBe('Old name'); expect(f.profile.description).toBe('Old bio');
		expect(f.user.avatarId).toBe('avatar'); expect(f.user.bannerId).toBe('banner');
		expect(f.drive.uploadFromUrl).toHaveBeenCalledWith({ url: original.avatarUrl, user: f.user });
		const writes = f.update.exec.mock.calls.length;
		f.user.name = 'New name'; f.profile.description = null;
		await f.call();
		expect(f.update.exec).toHaveBeenCalledTimes(writes); expect(f.profile.description).toBe(null);
	});
	test('preserves configured destination fields and does not download their images', async () => {
		const f = fixture(); f.user.name = 'Keep'; f.user.avatarId = 'own'; f.profile.fields = [{ name: 'Keep', value: 'me' }];
		const result = await f.call();
		expect(result.skipped).toEqual(expect.arrayContaining(['name', 'avatarId', 'fields']));
		expect(f.user.name).toBe('Keep'); expect(f.user.avatarId).toBe('own');
		expect(f.drive.uploadFromUrl).toHaveBeenCalledTimes(1);
	});
	test('retains text and retries only a failed image', async () => {
		const f = fixture(); f.drive.uploadFromUrl.mockRejectedValueOnce(new Error('offline'));
		expect(await f.call()).toMatchObject({ complete: false, failed: ['avatarId'] });
		expect(f.profile.description).toBe('Old bio');
		f.profile.description = 'Edited after partial success';
		expect(await f.call()).toMatchObject({ complete: true, failed: [] });
		expect(f.profile.description).toBe('Edited after partial success');
		expect(f.drive.uploadFromUrl).toHaveBeenCalledTimes(3);
	});
	test('rechecks consent before changing any profile field', async () => {
		const f = fixture(); f.links.profile.mockResolvedValueOnce({ peerOrigin: 'https://r.example', peerUserId: 'old', profile: original }).mockRejectedValue(new GridspaceLinkError('LINK_REVOKED'));
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_PROFILE_UNAVAILABLE' });
		expect(f.update.exec).not.toHaveBeenCalled();
	});
	test('preserves a local avatar set while the source image was downloading', async () => {
		const f = fixture(); f.drive.uploadFromUrl.mockImplementation(async () => { f.user.avatarId = 'edited'; return { id: 'download' } as never; });
		await f.call(); expect(f.user.avatarId).toBe('edited');
		expect(f.update.exec.mock.calls.every(([patch]) => !('avatarId' in patch))).toBe(true);
	});
	test('rejects a changed link generation during an image download', async () => {
		const f = fixture();
		f.drive.uploadFromUrl.mockImplementation(async () => {
			f.links.privateLink.mockResolvedValue({ id: 'link', generation: 2, tokenCipher: 'new', peerUserId: 'old', peerOrigin: 'https://r.example' } as never);
			return { id: 'download' } as never;
		});
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_PROFILE_UNAVAILABLE' });
		expect(f.user.avatarId).toBe(null);
	});
	test('parses only public display fields and rejects unsafe image URL schemes', () => {
		expect(parseLinkedProfile({ ...original, password: 'secret', isLocked: false })).toEqual(original);
		for (const avatarUrl of ['file:///secret', 'data:image/png;base64,AA', 'https://name:password@example.com/a']) expect(() => parseLinkedProfile({ ...original, avatarUrl })).toThrow();
	});
	test('maps a preinstalled decoration to its local ID and preserves transforms and order', async () => {
		const f = fixture();
		const decoration = { name: 'Hat', url: 'https://cdn.example/hat.png', angle: 0.2, flipH: true, offsetX: -0.1, offsetY: 0.15 };
		f.links.profile.mockResolvedValue({ peerOrigin: 'https://r.example', peerUserId: 'old', profile: { ...original, avatarDecorations: [decoration, { ...decoration, angle: -0.3 }] } });
		f.definitions.push({ id: 'local-hat', name: decoration.name, url: decoration.url, roleIdsThatCanBeUsedThisDecoration: [] } as unknown as MiAvatarDecoration);
		expect(await f.call()).toMatchObject({ complete: true, copied: expect.arrayContaining(['avatarDecorations']) });
		expect(f.user.avatarDecorations).toEqual([0.2, -0.3].map(angle => ({ id: 'local-hat', angle, flipH: true, offsetX: -0.1, offsetY: 0.15 })));
		f.user.avatarDecorations = [];
		await f.call(); expect(f.user.avatarDecorations).toEqual([]);
	});
	test('does not silently drop missing or role-restricted decorations and can retry after catalog import', async () => {
		const f = fixture();
		const decoration = { name: 'Hat', url: 'https://cdn.example/hat.png', angle: 0, flipH: false, offsetX: 0, offsetY: 0 };
		f.links.profile.mockResolvedValue({ peerOrigin: 'https://r.example', peerUserId: 'old', profile: { ...original, avatarDecorations: [decoration] } });
		expect(await f.call()).toMatchObject({ complete: false, failed: ['avatarDecorations'] });
		f.definitions.push({ id: 'hat', name: decoration.name, url: decoration.url, roleIdsThatCanBeUsedThisDecoration: ['restricted'] } as unknown as MiAvatarDecoration);
		f.roles.getRoles.mockResolvedValue([{ id: 'restricted' }] as never);
		expect(await f.call()).toMatchObject({ complete: false, failed: ['avatarDecorations'] });
		f.roles.getUserRoles.mockResolvedValue([{ id: 'restricted' }] as never);
		expect(await f.call()).toMatchObject({ complete: true });
	});
	test('preserves destination decorations and rejects invalid transform values', async () => {
		const f = fixture(); f.user.avatarDecorations = [{ id: 'keep' }];
		expect(await f.call()).toMatchObject({ skipped: expect.arrayContaining(['avatarDecorations']) });
		expect(f.user.avatarDecorations).toEqual([{ id: 'keep' }]);
		expect(() => parseLinkedProfile({ ...original, avatarDecorations: [{ name: 'Bad', url: 'file:///secret', angle: 0, flipH: false, offsetX: 0, offsetY: 0 }] })).toThrow();
		expect(() => parseLinkedProfile({ ...original, avatarDecorations: [{ name: 'Bad', url: 'https://cdn.example/a', angle: 20, flipH: false, offsetX: 0, offsetY: 0 }] })).toThrow();
	});
});
