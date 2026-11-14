/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { MiUser } from '@/models/User.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { MiGridspaceAuthSession, MiGridspaceImportItem, MiGridspaceLink } from '@/models/Gridspace.js';
import type { UserFollowingService } from '@/core/UserFollowingService.js';
import type { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import type { IdService } from '@/core/IdService.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { profileFields } from './profile-protocol.js';
import { sealGridspaceSecret } from './link-crypto.js';

function fixture() {
	const db = mockDeep<DataSource>(), modules = mockDeep<ModuleRef>();
	const service = new GridspaceLinkService({ url: 'https://g.example', gridspace: { channelRole: 'client' } } as Config, db,
		mockDeep<UserFollowingService>(), mockDeep<ApPersonService>(), mockDeep<GridspaceFollowGuardService>(), mockDeep<IdService>(), modules);
	const peer = { origin: 'https://g.example', peerOrigin: 'https://r.example', communityId: 'test', keyId: 'test', secret: Buffer.alloc(32, 7) };
	service['peer'] = peer;
	const link = { id: 'link', generation: 1, localUserId: 'new', peerUserId: 'old', peerOrigin: peer.peerOrigin, initiator: true, state: 'active', tokenCipher: sealGridspaceSecret(peer, 'token', 'link') } as MiGridspaceLink;
	let receipt: object | null = null;
	const execute = vi.fn(async () => { receipt = { copied: [...profileFields], skipped: [] }; return { complete: true }; });
	modules.get.mockReturnValue({ exec: execute });
	const builder = { where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValue([]) };
	const linksBuilder = { ...builder, getMany: vi.fn().mockResolvedValue([link]) };
	const update = vi.fn();
	db.getRepository.mockImplementation(((entity: unknown) => {
		if (entity === MiRegistryItem) return { findOneBy: async () => receipt ? { value: receipt } : null };
		if (entity === MiUser) return { findOneBy: async () => ({ id: 'new' }) };
		if (entity === MiGridspaceAuthSession) return { delete: vi.fn() };
		if (entity === MiGridspaceLink) return { findOneBy: async (where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => link[key as keyof MiGridspaceLink] === value) ? link : null, update, createQueryBuilder: () => linksBuilder };
		if (entity === MiGridspaceImportItem) return { find: async () => [{ id: 'item' }] };
		throw new Error('Unexpected repository');
	}) as DataSource['getRepository']);
	vi.spyOn(service, 'json').mockResolvedValue({ ok: true });
	const importItem = vi.spyOn(service as never, 'importItem' as never).mockResolvedValue(undefined as never);
	return { service, execute, importItem, update, link, setReceipt: (value: object) => { receipt = value; } };
}

test('waits for profile persistence before sending any initial follows and does not import twice', async () => {
	const f = fixture(); let release!: () => void;
	const copy = f.execute.getMockImplementation()!;
	f.execute.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return copy(); });
	const work = f.service['work']();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(f.execute).toHaveBeenCalledOnce(); expect(f.importItem).not.toHaveBeenCalled();
	release(); await work;
	expect(f.importItem).toHaveBeenCalledOnce();
	await f.service.ensureProfileBeforeFollowing(f.link);
	expect(f.execute).toHaveBeenCalledOnce();
});

test('failed image import keeps follows pending, backs off, and retries successfully', async () => {
	vi.useFakeTimers();
	try {
		const f = fixture(); f.execute.mockResolvedValueOnce({ complete: false });
		await f.service['work']();
		expect(f.importItem).not.toHaveBeenCalled();
		expect(f.update).toHaveBeenCalledWith(expect.anything(), { lastError: 'PROFILE_PENDING' });
		await f.service['work'](); expect(f.execute).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(60001); await f.service['work']();
		expect(f.execute).toHaveBeenCalledTimes(2); expect(f.importItem).toHaveBeenCalledOnce();
	} finally { vi.useRealTimers(); }
});

test('a partial receipt is not ready, and readiness is only exposed for an active matching peer link', async () => {
	const f = fixture(); f.setReceipt({ copied: ['name'], skipped: [] });
	const work = vi.spyOn(f.service as never, 'work' as never).mockResolvedValue(undefined as never);
	expect(await f.service.peerAction('profile-ready', { linkId: 'link', localUserId: 'old', generation: 1 })).toEqual({ ready: false });
	expect(f.update).toHaveBeenCalledWith({ id: 'link', generation: 1, state: 'active' }, { lastError: 'PROFILE_PENDING' });
	expect(work).toHaveBeenCalledOnce();
	await f.service.ensureProfileBeforeFollowing(f.link);
	expect(await f.service.peerAction('profile-ready', { linkId: 'link', localUserId: 'old', generation: 1 })).toEqual({ ready: true });
	await expect(f.service.peerAction('profile-ready', { linkId: 'link', localUserId: 'old', generation: 2 })).rejects.toMatchObject({ code: 'LINK_REVOKED' });
	await expect(f.service.peerAction('profile-ready', { linkId: 'link', localUserId: 'other', generation: 1 })).rejects.toMatchObject({ code: 'LINK_REVOKED' });
});
