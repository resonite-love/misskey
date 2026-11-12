/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiMuting } from '@/models/Muting.js';
import type { RegistryApiService } from '@/core/RegistryApiService.js';
import type { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import type { UserMutingService } from '@/core/UserMutingService.js';
import SettingsImport from '@/server/api/endpoints/gridspace/settings-import.js';
import type Update from '@/server/api/endpoints/i/update.js';
import type Block from '@/server/api/endpoints/blocking/create.js';
import type Mute from '@/server/api/endpoints/mute/create.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import { parseSettingsSnapshot, settingsDomain, type SettingsSnapshot } from './settings-protocol.js';

const requestId = 'd47fdf72-5caa-4adf-aac0-8d21ae99e45f';

function fixture(restrictions: SettingsSnapshot['restrictions'] = []) {
	const user = { id: 'me' } as MiLocalUser;
	const links = mockDeep<GridspaceLinkService>();
	const binding = { linkId: 'link', generation: 1, credentialHash: 'token-hash', peerUserId: 'old', peerOrigin: 'https://r.example' };
	const snapshot: SettingsSnapshot = { account: { isLocked: true }, client: '{"version":1}', restrictions };
	links.settings.mockImplementation(async () => ({ ...binding, settings: structuredClone(snapshot) }));
	links.checkSettingsAuthorization.mockImplementation(async () => ({ ...binding }));
	const guard = mockDeep<GridspaceFollowGuardService>(); guard.runProfile.mockImplementation(async (_id, action) => action());
	const registry = mockDeep<RegistryApiService>(); let saved: unknown;
	registry.getItem.mockImplementation(async () => saved ? { value: structuredClone(saved) } as never : null);
	registry.set.mockImplementation(async (_id, _domain, _scope, _key, value) => { saved = structuredClone(value); });
	const people = mockDeep<ApPersonService>(); people.resolvePerson.mockImplementation(async uri => ({ id: String(uri).split('/').at(-1) }) as never);
	const db = mockDeep<DataSource>();
	let existingMute = false;
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiUser ? { findOneBy: async () => null, findOneByOrFail: async ({ id }: { id: string }) => ({ id }) } :
		entity === MiUserProfile ? { findOneByOrFail: async () => ({ notificationRecieveConfig: { reaction: { type: 'following' } } }) } : { existsBy: async () => entity === MiMuting && existingMute }) as DataSource['getRepository']);
	const update = mockDeep<Update>(); const block = mockDeep<Block>(); const mute = mockDeep<Mute>(); const muting = mockDeep<UserMutingService>();
	muting.extendMute.mockResolvedValue(true);
	const endpoint = new SettingsImport(links, guard, registry, people, db, { url: 'https://g.example', gridspace: { channelRole: 'client' } } as Config, update, block, mute, muting);
	return { snapshot, binding, registry, people, update, block, mute, muting, existingMute: () => { existingMute = true; }, call: (action = 'start', id = requestId) => endpoint.exec({ action, requestId: id }, user, null) };
}

describe('linked settings import', () => {
	test('limits each batch, resumes a lost response and never reapplies edited account settings', async () => {
		const f = fixture(Array.from({ length: 12 }, (_, i) => ({ kind: 'block', uri: `https://r.example/users/u${i}`, expiresAt: null })));
		expect(await f.call()).toMatchObject({ done: 5, pending: 7, complete: false });
		expect(await f.call('status')).toMatchObject({ done: 5 });
		expect(f.block.exec).toHaveBeenCalledTimes(5);
		expect(await f.call()).toMatchObject({ done: 10, pending: 2 });
		expect(await f.call('step')).toMatchObject({ done: 12, complete: true });
		expect(f.update.exec).toHaveBeenCalledTimes(1);
		expect(f.registry.set.mock.calls.every(([, domain]) => domain === settingsDomain)).toBe(true);
		expect(await f.call('status')).not.toHaveProperty('restrictions');
	});
	test('retries only failed restrictions', async () => {
		const f = fixture([{ kind: 'block', uri: 'https://r.example/users/a', expiresAt: null }, { kind: 'mute', uri: 'https://r.example/users/b', expiresAt: null }]);
		f.block.exec.mockRejectedValueOnce(new Error('offline'));
		expect(await f.call()).toMatchObject({ done: 1, failed: 1, pending: 0 });
		expect(await f.call('retry')).toMatchObject({ complete: true, done: 2, failed: 0 });
		expect(f.mute.exec).toHaveBeenCalledTimes(1); expect(f.update.exec).toHaveBeenCalledTimes(1);
	});
	test('rejects replacement bindings after resolving a remote actor', async () => {
		const f = fixture([{ kind: 'block', uri: 'https://r.example/users/a', expiresAt: null }]);
		f.people.resolvePerson.mockImplementation(async () => { f.binding.credentialHash = 'replacement'; return { id: 'a' } as never; });
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_SETTINGS_UNAVAILABLE' });
		expect(f.block.exec).not.toHaveBeenCalled();
	});
	test('preserves destination notification filters instead of copying source-local list IDs', async () => {
		const f = fixture(); f.snapshot.account = { isLocked: true, notificationRecieveConfig: { reaction: { type: 'list', userListId: 'old-list' }, mention: { type: 'all' } }, email: 'secret' };
		await f.call();
		expect(f.update.exec.mock.calls[0][0]).toEqual({ isLocked: true, notificationRecieveConfig: { reaction: { type: 'following' }, mention: { type: 'all' } } });
	});
	test('retains existing restrictions, extends mute expiry, skips expired source mutes and self blocks', async () => {
		const f = fixture([{ kind: 'mute', uri: 'https://r.example/users/a', expiresAt: null }, { kind: 'mute', uri: 'https://r.example/users/expired', expiresAt: 1 }, { kind: 'block', uri: 'https://g.example/users/me', expiresAt: null }]);
		f.existingMute(); expect(await f.call()).toMatchObject({ complete: true, done: 3 });
		expect(f.muting.extendMute).toHaveBeenCalledWith('me', 'a', null);
		expect(f.mute.exec).not.toHaveBeenCalled(); expect(f.block.exec).not.toHaveBeenCalled();
	});
	test('only an explicit new request overwrites settings again', async () => {
		const f = fixture(); await f.call(); await f.call('retry'); expect(f.update.exec).toHaveBeenCalledTimes(1);
		await f.call('start', 'a47fdf72-5caa-4adf-aac0-8d21ae99e45f'); expect(f.update.exec).toHaveBeenCalledTimes(2);
	});
	test('recreates a source mute if expiration cleanup deleted the existing row before extension', async () => {
		const f = fixture([{ kind: 'mute', uri: 'https://r.example/users/a', expiresAt: null }]);
		f.existingMute(); f.muting.extendMute.mockResolvedValue(false);
		expect(await f.call()).toMatchObject({ complete: true });
		expect(f.mute.exec).toHaveBeenCalledWith({ userId: 'a', expiresAt: null }, expect.anything(), null);
	});
	test('rejects unsafe actor URIs and drops credential fields', () => {
		expect(parseSettingsSnapshot({ account: { password: 'secret', isLocked: true }, client: null, restrictions: [] }).account).toEqual({ isLocked: true });
		expect(() => parseSettingsSnapshot({ account: {}, client: null, restrictions: [{ kind: 'block', uri: 'file:///secret', expiresAt: null }] })).toThrow();
	});
});
