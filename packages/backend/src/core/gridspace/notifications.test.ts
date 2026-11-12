/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { MiNotification } from '@/models/Notification.js';
import type { Packed } from '@/misc/json-schema.js';
import type { PrivateWireNote } from './private-protocol.js';
import type { ModuleRef } from '@nestjs/core';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiGridspaceLink } from '@/models/Gridspace.js';
import type { NotificationService } from '@/core/NotificationService.js';
import type { NotificationReadService } from '@/core/NotificationReadService.js';
import type { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { GridspaceNotificationService } from './GridspaceNotificationService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceSearchService } from './GridspaceSearchService.js';
import type { NotificationOptions, WireNotification } from './notification-protocol.js';

function fixture() {
	const links = mockDeep<GridspaceLinkService>();
	const notes = mockDeep<GridspacePrivateService>();
	const notifications = mockDeep<NotificationService>();
	const reads = mockDeep<NotificationReadService>();
	const packer = mockDeep<NotificationEntityService>();
	const link = { peerOrigin: 'https://r.example', peerUserId: 'old', localUserId: 'viewer' } as MiGridspaceLink;
	links.privateLink.mockResolvedValue(link);
	links.authorizePrivate.mockResolvedValue(link);
	links.privateCredential.mockReturnValue({ accessToken: 'pair-token', linkId: 'real-link', localUserId: 'viewer', generation: 2 });
	notes.localActorAllows.mockResolvedValue(true); notes.localAllows.mockResolvedValue(true);
	const db = mockDeep<DataSource>();
	db.transaction.mockImplementation((async (run: (manager: EntityManager) => Promise<unknown>) => run(db.manager)) as DataSource['transaction']);
	const moduleRef = mockDeep<ModuleRef>();
	const following = mockDeep<UserFollowingService>();
	const users = mockDeep<UserEntityService>();
	moduleRef.get.mockImplementation(((token: unknown) => token === UserFollowingService ? following : users) as ModuleRef['get']);
	users.pack.mockResolvedValue({ id: 'viewer', username: 'viewer', host: null } as Packed<'UserLite'>);
	const search = mockDeep<GridspaceSearchService>();
	const service = new GridspaceNotificationService({ url: 'https://g.example' } as Config, db, notifications, reads, packer, links, notes, search, moduleRef);
	return { service, following, users, search, db, links, notes, notifications, reads, packer, viewer: { id: 'viewer' } as MiLocalUser };
}

describe('GridSpace notifications', () => {
	test('never forwards caller secrets or allows caller-supplied binding overrides', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ items: [], origin: 'https://r.example', recipientId: 'old' });
		await f.service.remote(f.viewer, { i: 'login-secret', accessToken: 'evil', linkId: 'wrong', source: 'peer', before: 'cursor' } as NotificationOptions);
		const body = f.links.json.mock.calls[0][1];
		expect(body).not.toHaveProperty('i'); expect(body).not.toHaveProperty('source');
		expect(body).toMatchObject({ accessToken: 'pair-token', linkId: 'real-link', before: 'cursor', generation: 2 });
	});
	test('requires notification consent in addition to the linked private-reader grant', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(false);
		await expect(f.service.peer('query', {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		await expect(f.service.peer('read', { ids: ['id'] })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.notifications.readNotifications).not.toHaveBeenCalled();
	});
	test('checks uncached notifier host/mutes even for notifications without a note', async () => {
		const f = fixture(); f.notes.localActorAllows.mockResolvedValue(false);
		f.links.json.mockResolvedValue({ items: [{ id: 'follow', user: { host: 'muted.example' }, note: null }], origin: 'https://r.example', recipientId: 'old' });
		expect((await f.service.remote(f.viewer, {})).items).toEqual([]);
		expect(f.notes.localActorAllows).toHaveBeenCalled();
	});
	test('rejects a response for another recipient or origin', async () => {
		const f = fixture();
		for (const patch of [{ origin: 'https://elsewhere.example' }, { recipientId: 'another' }]) {
			f.links.json.mockResolvedValue({ items: [], origin: 'https://r.example', recipientId: 'old', ...patch });
			await expect(f.service.remote(f.viewer, {})).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
		}
	});
	test('shares actor checks within one page but rechecks blocks on the next request', async () => {
		const f = fixture();
		const actor = { uri: 'https://r.example/users/actor', host: 'r.example', username: 'actor', name: null };
		const note = { id: 'note', filterActors: [actor] } as PrivateWireNote;
		f.links.json.mockResolvedValue({ items: [1, 2, 3].map(id => ({ id: String(id), user: actor, note })), origin: 'https://r.example', recipientId: 'old' });
		f.notes.localAllows.mockImplementation(async (_user, item, _home, _peer, check) => check!(item.filterActors[0]));
		expect((await f.service.remote(f.viewer, {})).items).toHaveLength(3);
		expect(f.notes.localActorAllows).toHaveBeenCalledTimes(1);
		f.notes.localActorAllows.mockResolvedValue(false);
		expect((await f.service.remote(f.viewer, {})).items).toEqual([]);
		expect(f.notes.localActorAllows).toHaveBeenCalledTimes(2);
		expect(f.links.checkPrivateUnchanged).toHaveBeenCalledTimes(2);
	});
	test('batch notifier lookup still excludes blocked or suspended actors', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		const rows = ['allowed', 'blocked', 'allowed'].map((notifierId, i) => ({ id: String(i), type: 'follow', notifierId, createdAt: new Date().toISOString() } as MiNotification));
		f.notifications.getNotifications.mockResolvedValue(rows);
		f.packer.packMany.mockResolvedValue(rows.map(n => ({ ...n, user: { id: 'actor' } })) as Packed<'Notification'>[]);
		const query = { andWhere: () => query, getMany: async () => [{ id: 'allowed', username: 'allowed', host: null, uri: null, name: null }] };
		f.search.userQuery.mockReturnValue(query as unknown as ReturnType<GridspaceSearchService['userQuery']>);
		f.reads.state.mockResolvedValue({ unreadCount: 3, changed: false, isRead: [false, false] });
		const result = await f.service.peer('query', {});
		expect(result.items.map(n => n.id)).toEqual(['0', '2']);
		expect(f.search.userQuery).toHaveBeenCalledTimes(1);
		expect(f.search.userQuery).toHaveBeenCalledWith({ id: 'viewer' });
	});
	test('does not mark anything read when querying, including an excluded page', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		f.notifications.getNotifications.mockResolvedValue([{ id: 'test', createdAt: '2026-11-12T00:00:00Z', type: 'test' }]);
		f.packer.packMany.mockResolvedValue([]); f.reads.state.mockResolvedValue({ unreadCount: 1, changed: false, isRead: [] });
		const result = await f.service.peer('query', { excludeTypes: ['test'], limit: 1 });
		expect(result.items).toEqual([]); expect(result.next).toBe('test'); expect(result.unreadCount).toBe(1);
		expect(f.notifications.readNotifications).not.toHaveBeenCalled();
	});
	test('rechecks the local grant after fetching and filtering', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ items: [] as WireNotification[], origin: 'https://r.example', recipientId: 'old' });
		f.links.checkPrivateUnchanged.mockRejectedValue(new Error('revoked'));
		await expect(f.service.remote(f.viewer, {})).rejects.toThrow('revoked');
	});
	test('all-read requires a current write grant and is never inferred from query options', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		f.notifications.readAllNotification.mockResolvedValue({ unreadCount: 0, changed: true, isRead: [] });
		expect((await f.service.peer('read-all', {})).unreadCount).toBe(0);
		expect(f.links.lockReplyAuthorization).toHaveBeenCalled();
		expect(f.notifications.readAllNotification).toHaveBeenCalledWith('viewer');
		f.notifications.readAllNotification.mockClear();
		f.links.lockReplyAuthorization.mockRejectedValue(new Error('revoked while waiting'));
		await expect(f.service.peer('read-all', {})).rejects.toThrow('revoked while waiting');
		expect(f.notifications.readAllNotification).not.toHaveBeenCalled();
	});
	test('binds a decision to the exact received request and write permission', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		f.notifications.getNotification.mockResolvedValue({ id: 'n', type: 'receiveFollowRequest', notifierId: 'actor', followRequestId: 'original' } as MiNotification);
		await expect(f.service.peer('accept-follow', { ids: ['n'], followRequestId: 'different' })).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		await expect(f.service.peer('accept-follow', { ids: ['n'], followRequestId: 'original' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.following.decideAuthorizedFollowRequest).not.toHaveBeenCalled();
		f.links.hasFollowRequestScope.mockResolvedValue(true);
		f.following.decideAuthorizedFollowRequest.mockResolvedValue(false);
		await expect(f.service.peer('accept-follow', { ids: ['n'], followRequestId: 'original' })).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		f.following.decideAuthorizedFollowRequest.mockResolvedValue(true);
		f.reads.state.mockResolvedValue({ unreadCount: 1, changed: false, isRead: [] });
		await f.service.peer('reject-follow', { ids: ['n'], followRequestId: 'original' });
		expect(f.following.decideAuthorizedFollowRequest).toHaveBeenLastCalledWith('viewer', 'actor', 'original', false, expect.any(Function));
		await f.following.decideAuthorizedFollowRequest.mock.calls.at(-1)![4](f.db.manager);
		expect(f.links.lockReplyAuthorization).toHaveBeenCalledWith(expect.objectContaining({ followRequestId: 'original' }), f.db.manager, 'write:following');
	});
	test('validates all 200 note IDs for 100 renotes in bounded batches', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		const rows = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, type: 'renote', noteId: `wrapper${i}`, notifierId: 'actor', createdAt: new Date().toISOString() } as MiNotification));
		f.notifications.getNotifications.mockResolvedValue(rows);
		f.packer.packMany.mockResolvedValue(rows.map((n, i) => ({ ...n, user: { id: 'actor' }, note: { id: `wrapper${i}`, renoteId: `target${i}`, user: { id: 'actor' } } })) as Packed<'Notification'>[]);
		const query = { andWhere: () => query, getMany: async () => [{ id: 'actor', username: 'actor', host: null, uri: null, name: null }] };
		f.search.userQuery.mockReturnValue(query as unknown as ReturnType<GridspaceSearchService['userQuery']>);
		f.notes.peerNotes.mockImplementation(async input => ({ notes: input.ids!.map(id => ({ id, renoteId: id.startsWith('wrapper') ? id.replace('wrapper', 'target') : null } as PrivateWireNote)), next: null, head: null, scannedThrough: null, observedAt: new Date().toISOString() }));
		f.reads.state.mockResolvedValue({ unreadCount: 100, changed: false, isRead: Array(100).fill(false) });
		const result = await f.service.peer('query', {});
		expect(f.notes.peerNotes.mock.calls.map(([p]) => p.ids?.length)).toEqual([100, 100]);
		expect(result.items).toHaveLength(100);
		expect(result.items.every(n => n.note && n.renote)).toBe(true);
		expect(f.links.authorizePrivate).toHaveBeenCalledTimes(2);
	});
});
