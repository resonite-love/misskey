/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiChannel } from '@/models/Channel.js';
import { MiChannelFollowing } from '@/models/ChannelFollowing.js';
import { MiChannelFavorite } from '@/models/ChannelFavorite.js';
import type { IdService } from '@/core/IdService.js';
import type { NoteDeleteService } from '@/core/NoteDeleteService.js';
import type { ChannelEntityService } from '@/core/entities/ChannelEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { GridspaceChannelService } from './GridspaceChannelService.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import type { ChannelAction } from './channel-protocol.js';

function fixture(guest = false) {
	const db = mockDeep<DataSource>(), manager = mockDeep<EntityManager>();
	const auth = mockDeep<GridspaceChannelAuthService>(), links = mockDeep<GridspaceLinkService>();
	const events = mockDeep<GlobalEventService>();
	const actor = guest ? 'remote-grid-user' : 'old-user';
	let following = false, favorite = false, exists = true;
	let committed = false;
	auth.source.mockResolvedValue({ id: actor } as never);
	links.authorizePrivate.mockResolvedValue({ localUserId: actor, initiator: false } as never);
	db.transaction.mockImplementation((async (fn: (manager: EntityManager) => unknown) => {
		const before = [following, favorite];
		try { const result = await fn(manager); committed = true; return result; } catch (error) { [following, favorite] = before; throw error; }
	}) as never);
	const builder = (isFollow: boolean) => {
		const value = { insert: vi.fn().mockReturnThis(), values: vi.fn().mockReturnThis(), orIgnore: vi.fn().mockReturnThis(), execute: vi.fn(async () => { if (isFollow) following = true; else favorite = true; }) };
		return value;
	};
	const followBuilder = builder(true), favoriteBuilder = builder(false);
	const followRepo = { createQueryBuilder: () => followBuilder, delete: vi.fn(async () => { following = false; }), existsBy: vi.fn(async () => following) };
	const favoriteRepo = { createQueryBuilder: () => favoriteBuilder, delete: vi.fn(async () => { favorite = false; }), existsBy: vi.fn(async () => favorite) };
	manager.getRepository.mockImplementation(((entity: unknown) => entity === MiChannel ? { existsBy: async () => exists } : entity === MiChannelFollowing ? followRepo : entity === MiChannelFavorite ? favoriteRepo : undefined) as EntityManager['getRepository']);
	events.publishInternalEvent.mockImplementation(() => { expect(committed).toBe(true); });
	const ids = mockDeep<IdService>(); ids.gen.mockReturnValue('generated');
	const service = new GridspaceChannelService(db, {} as Config, links, mockDeep<ChannelEntityService>(), auth, mockDeep<NoteDeleteService>(), ids, events);
	const run = (action: ChannelAction) => service.peerUpdate({ channelId: 'channel', action, ...(guest ? { channelActorId: 'grid-user' } : { linkId: 'link', localUserId: 'grid-user', generation: 1, pairId: 'pair', accessToken: 'secret' }) });
	return { run, service, links, auth, db, events, manager, actor, followBuilder, favoriteBuilder, followRepo, favoriteRepo, missing: () => { exists = false; } };
}

test.each([false, true])('follow and favorite are independent and idempotent (grid-only=%s)', async guest => {
	const f = fixture(guest);
	expect(await f.run('follow')).toEqual({ isFollowing: true, isFavorited: false });
	expect(await f.run('follow')).toEqual({ isFollowing: true, isFavorited: false });
	expect(await f.run('favorite')).toEqual({ isFollowing: true, isFavorited: true });
	expect(await f.run('favorite')).toEqual({ isFollowing: true, isFavorited: true });
	expect(await f.run('unfollow')).toEqual({ isFollowing: false, isFavorited: true });
	expect(await f.run('unfavorite')).toEqual({ isFollowing: false, isFavorited: false });
	expect(f.followBuilder.values).toHaveBeenCalledWith({ id: 'generated', followerId: f.actor, followeeId: 'channel' });
	expect(f.favoriteBuilder.values).toHaveBeenCalledWith({ id: 'generated', userId: f.actor, channelId: 'channel' });
	expect(f.followBuilder.orIgnore).toHaveBeenCalled(); expect(f.favoriteBuilder.orIgnore).toHaveBeenCalled();
	expect(f.events.publishInternalEvent).toHaveBeenCalledWith('followChannel', { userId: f.actor, channelId: 'channel' });
	expect(f.events.publishInternalEvent).toHaveBeenCalledWith('unfollowChannel', { userId: f.actor, channelId: 'channel' });
});

test.each([false, true])('revocation at commit rejects writes and cache events (grid-only=%s)', async guest => {
	const f = fixture(guest);
	if (guest) f.auth.source.mockResolvedValueOnce({ id: f.actor } as never).mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
	else f.links.lockReplyAuthorization.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
	await expect(f.run('follow')).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	expect(f.followBuilder.execute).not.toHaveBeenCalled(); expect(f.events.publishInternalEvent).not.toHaveBeenCalled();
	if (!guest) expect(f.links.lockReplyAuthorization).toHaveBeenCalledWith(expect.anything(), f.manager, 'write:gridspace-channel');
});

test('rejects unavailable channels and invalid actions before mutation', async () => {
	const f = fixture(); f.missing();
	await expect(f.run('favorite')).rejects.toMatchObject({ code: 'CHANNEL_UNAVAILABLE' });
	await expect(f.run('delete' as ChannelAction)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	expect(f.favoriteBuilder.execute).not.toHaveBeenCalled();
});

test('uses only the destination-authenticated identity and rechecks it after peer mutation', async () => {
	const f = fixture(); const check = vi.fn();
	f.auth.destination.mockResolvedValue({ credential: { channelActorId: 'current' }, peerOrigin: 'https://r.example', key: 'actor:current', peerUserId: '', check });
	f.links.json.mockResolvedValue({ isFollowing: true, isFavorited: false });
	await f.service.update({ id: 'current' } as MiLocalUser, { channelId: 'channel', action: 'follow' });
	expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/private/channel-update', { channelId: 'channel', action: 'follow', channelActorId: 'current' });
	expect(check).toHaveBeenCalledOnce();
});
