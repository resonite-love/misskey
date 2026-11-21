/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { GlobalEventService } from '@/core/GlobalEventService.js';
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
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspacePlacementService } from './GridspacePlacementService.js';
import type { MiNote } from '@/models/Note.js';
import { GridspaceNotificationService } from './GridspaceNotificationService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceSearchService } from './GridspaceSearchService.js';
import type { NotificationOptions, WireNotification } from './notification-protocol.js';

function fixture(role?: 'client' | 'source') {
	const links = mockDeep<GridspaceLinkService>();
	const notes = mockDeep<GridspacePrivateService>();
	notes.filterChannelRenote.mockImplementation((...args) => GridspacePrivateService.prototype.filterChannelRenote.call(notes, ...args));
	const notifications = mockDeep<NotificationService>();
	notifications.readNotifications.mockResolvedValue({ changed: false, isRead: [], unreadCount: 0 });
	const reads = mockDeep<NotificationReadService>();
	const packer = mockDeep<NotificationEntityService>();
	const link = { peerOrigin: 'https://r.example', peerUserId: 'old', localUserId: 'viewer' } as MiGridspaceLink;
	links.privateLink.mockResolvedValue(link);
	links.authorizePrivate.mockResolvedValue(link);
	links.privateCredential.mockReturnValue({ accessToken: 'pair-token', linkId: 'real-link', localUserId: 'viewer', generation: 2 });
	notes.localActorAllows.mockResolvedValue(true); notes.localAllows.mockResolvedValue(true);
	notes.localActorChecker.mockImplementation(async (user, actors) => {
		const decisions = new Map<string, boolean>();
		for (const actor of actors) {
			const key = JSON.stringify([actor.uri, actor.host]);
			if (!decisions.has(key)) decisions.set(key, await notes.localActorAllows(user, actor));
		}
		return async actor => decisions.get(JSON.stringify([actor.uri, actor.host])) ?? false;
	});
	notes.actorsForNotes.mockImplementation(items => items.flatMap(note => [...note.filterActors, ...(note.renote?.filterActors ?? [])]));
	const db = mockDeep<DataSource>();
	db.transaction.mockImplementation((async (run: (manager: EntityManager) => Promise<unknown>) => run(db.manager)) as DataSource['transaction']);
	const moduleRef = mockDeep<ModuleRef>();
	const placements = mockDeep<GridspacePlacementService>();
	placements.currentActorCredential.mockResolvedValue({ actorId: 'viewer' });
	placements.resolveActor.mockResolvedValue({ id: 'remoteViewer' } as never);
	placements.hasPeerCapability.mockResolvedValue(true);
	const events = mockDeep<GlobalEventService>();
	const following = mockDeep<UserFollowingService>();
	const users = mockDeep<UserEntityService>();
	moduleRef.get.mockImplementation(((token: unknown) => token === GlobalEventService ? events : token === GridspacePlacementService ? placements : token === UserFollowingService ? following : users) as ModuleRef['get']);
	users.pack.mockResolvedValue({ id: 'viewer', username: 'viewer', host: null } as Packed<'UserLite'>);
	const search = mockDeep<GridspaceSearchService>();
	const channels = mockDeep<GridspaceChannelAuthService>();
	const service = new GridspaceNotificationService({ url: 'https://g.example', gridspace: role ? { enabled: true, channelRole: role, peerUrl: 'https://r.example' } : undefined } as Config, db, notifications, reads, packer, links, notes, search, moduleRef, channels);
	return { service, events, placements, channels, following, users, search, db, links, notes, notifications, reads, packer, viewer: { id: 'viewer' } as MiLocalUser };
}

describe('GridSpace notifications', () => {
	test('does not display or count a channel notification rejected by current visibility/mute filters', async () => {
		const f = fixture(); f.channels.source.mockResolvedValue({ id: 'remoteViewer' } as never);
		const row = { id: 'hidden', type: 'reaction', noteId: 'mutedChannelNote', notifierId: 'reactor', reaction: '👍', createdAt: new Date().toISOString() } as MiNotification;
		f.notifications.getNotifications.mockResolvedValue([row]);
		f.db.getRepository.mockReturnValue({ findBy: async () => [{ id: row.noteId, channelId: 'muted' }] } as never);
		const query = { andWhere: () => query };
		f.search.noteQuery.mockReturnValue(query as never); f.search.read.mockResolvedValue([]);
		f.packer.packMany.mockResolvedValue([]); f.reads.state.mockResolvedValue({ unreadCount: 1, changed: false, isRead: [] });
		const page = await f.service.peer('query', { channelActorId: 'viewer' });
		expect(page.items).toEqual([]); expect(page.unreadCount).toBe(0);
		await f.service.peer('read', { channelActorId: 'viewer', ids: [row.id] });
		expect(f.notifications.readNotifications).toHaveBeenCalledWith('remoteViewer', []);
	});

	test('counts and marks only still-visible channel reactions, not other inbox entries', async () => {
		const f = fixture(); f.channels.source.mockResolvedValue({ id: 'remoteViewer' } as never);
		vi.spyOn(f.service as never, 'channelRows' as never).mockResolvedValue([{ id: 'visible' }] as never);
		f.reads.state.mockResolvedValue({ unreadCount: 99, changed: false, isRead: [false] });
		f.notifications.getNotifications.mockResolvedValue([]); f.packer.packMany.mockResolvedValue([]);
		expect((await f.service.peer('query', { channelActorId: 'viewer', countOnly: true })).unreadCount).toBe(1);
		await f.service.peer('read-all', { channelActorId: 'viewer' });
		expect(f.notifications.readNotifications).toHaveBeenCalledWith('remoteViewer', ['visible']);
		expect(f.notifications.readAllNotification).not.toHaveBeenCalled();
	});

	test('reads channel reactions with the current identity even without an old-account link', async () => {
		const f = fixture();
		f.channels.destination.mockResolvedValue({ credential: { channelActorId: 'viewer' }, peerOrigin: 'https://r.example', key: 'actor:viewer', peerUserId: '', check: async () => {} });
		f.links.privateLink.mockRejectedValue(new Error('no old account'));
		f.links.json.mockResolvedValue({ items: [{ id: 'reaction', type: 'reaction', note: { id: 'n', channelId: 'channel', author: { uri: 'https://g.example/users/viewer' }, filterActors: [] } }], origin: 'https://r.example', recipientId: 'remoteViewer' });
		expect((await f.service.remote(f.viewer, {}, 'query', true)).items).toHaveLength(1);
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/notifications/query', expect.objectContaining({ channelActorId: 'viewer' }));
		expect(f.links.privateLink).not.toHaveBeenCalled();
	});
	test('rejects another author or a non-channel response on the channel inbox', async () => {
		const f = fixture();
		f.channels.destination.mockResolvedValue({ credential: { channelActorId: 'viewer' }, peerOrigin: 'https://r.example', key: 'actor:viewer', peerUserId: '', check: async () => {} });
		for (const note of [{ channelId: 'channel', author: { uri: 'https://g.example/users/other' } }, { channelId: null, author: { uri: 'https://g.example/users/viewer' } }]) {
			f.links.json.mockResolvedValue({ items: [{ id: 'n', type: 'reaction', note }], origin: 'https://r.example', recipientId: 'remoteViewer' });
			await expect(f.service.remote(f.viewer, {}, 'query', true)).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
		}
	});
	test('authorizes and rechecks a channel identity before marking notifications read', async () => {
		const f = fixture();
		f.channels.source.mockResolvedValue({ id: 'remoteViewer' } as never);
		vi.spyOn(f.service as never, 'channelRows' as never).mockResolvedValue([{ id: 'reaction' }] as never);
		f.reads.state.mockResolvedValue({ unreadCount: 0, changed: false, isRead: [true] });
		f.notifications.readNotifications.mockResolvedValue({ unreadCount: 0, changed: true, isRead: [true] });
		await f.service.peer('read', { channelActorId: 'viewer', ids: ['reaction'] });
		expect(f.channels.source).toHaveBeenCalledWith('viewer', f.db.manager);
		expect(f.notifications.readNotifications).toHaveBeenCalledWith('remoteViewer', ['reaction']);
		await expect(f.service.peer('accept-follow', { channelActorId: 'viewer' })).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		await expect(f.service.peer('query', { channelActorId: 'viewer', accessToken: 'mixed' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('channel inbox exposes only reactions on posts owned by its resolved actor', async () => {
		const f = fixture(); f.channels.source.mockResolvedValue({ id: 'remoteViewer' } as never);
		const rows = ['owned', 'other'].map((noteId, i) => ({ id: String(i), type: 'reaction', noteId, notifierId: 'reactor', reaction: '👍', createdAt: new Date().toISOString() } as MiNotification));
		f.notifications.getNotifications.mockResolvedValue(rows);
		f.db.getRepository.mockReturnValue({ findBy: async () => [{ id: 'owned', channelId: 'channel' }] } as never);
		f.packer.packMany.mockImplementation(async rows => rows.map(row => ({ ...row, user: { id: 'reactor' }, note: { user: { id: 'remoteViewer' } } })) as never);
		const query = { andWhere: () => query, getMany: async () => [{ id: 'reactor', username: 'reactor', host: null, uri: null, name: null }] };
		f.search.userQuery.mockReturnValue(query as never);
		f.search.noteQuery.mockReturnValue(query as never);
		f.search.read.mockResolvedValue([{ id: 'owned', userId: 'remoteViewer', channelId: 'channel' } as MiNote]);
		f.notes.peerNotes.mockResolvedValue({ notes: [{ id: 'owned' } as PrivateWireNote], next: null, head: null, scannedThrough: null, observedAt: '' });
		f.reads.state.mockResolvedValue({ unreadCount: 1, changed: false, isRead: [false] });
		const result = await f.service.peer('query', { channelActorId: 'viewer' });
		expect(result.items.map(n => n.id)).toEqual(['0']);
		expect(f.notes.peerNotes).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'channel', channelActorId: 'viewer', ids: ['owned'] }));
	});

	test.each([true, false])('filters nested previews in both notification note fields (%s)', async readable => {
		const f = fixture();
		const preview = { id: 'original', text: 'Own follower post', filterActors: [], renote: { text: 'deeper' } };
		const note = { id: 'wrapper', filterActors: [], renote: preview };
		f.notes.localAllows.mockImplementation(async (_user, item) => item.id === 'wrapper' || readable);
		f.links.json.mockResolvedValue({ items: [{ id: 'notification', note, renote: note }], origin: 'https://r.example', recipientId: 'old' });
		const result = await f.service.remote(f.viewer, {});
		for (const item of [result.items[0].note, result.items[0].renote]) {
			expect(item).not.toHaveProperty('filterActors');
			if (readable) expect(item?.renote).toEqual({ id: 'original', text: 'Own follower post' });
			else expect(item).not.toHaveProperty('renote');
		}
		expect(f.notes.filterChannelRenote).toHaveBeenCalledTimes(2);
		expect(f.links.checkPrivateUnchanged).toHaveBeenCalledOnce();
	});

	test('never forwards caller secrets or allows caller-supplied binding overrides', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ items: [], origin: 'https://r.example', recipientId: 'old' });
		await f.service.remote(f.viewer, { i: 'login-secret', accessToken: 'evil', linkId: 'wrong', source: 'peer', before: 'cursor' } as NotificationOptions);
		const body = f.links.json.mock.calls[0][1];
		expect(body).not.toHaveProperty('i'); expect(body).not.toHaveProperty('source');
		expect(body).toMatchObject({ accessToken: 'pair-token', linkId: 'real-link', before: 'cursor', generation: 2 });
	});
	test.each(['source', 'client'] as const)('filters current guest references, bodies, counts and reads on the %s', async role => {
		const f = fixture(role);
		const actor = { id: 'childAuthor', uri: 'https://g.example/users/childAuthor', username: 'child', host: null, name: null };
		const query = { andWhere: () => query, getMany: async () => [actor] };
		f.search.userQuery.mockReturnValue(query as never);
		f.search.noteQuery.mockReturnValue(query as never);
		const base = { multiNoteKind: 'conversation-reply', includeDefault: false, multiNoteRootId: 'root', channelId: null, uri: null, localOnly: true, visibility: 'public' };
		const notes = [
			{ ...base, id: 'child', userId: actor.id, replyUserId: 'remoteViewer' },
			{ ...base, id: 'mine', userId: 'remoteViewer' },
			{ ...base, id: 'other', userId: 'someone' },
			{ ...base, id: 'standard', multiNoteKind: null, userId: 'remoteViewer' },
		];
		f.search.read.mockResolvedValue(notes as MiNote[]);
		const ids = ['child', 'mine', 'other', 'standard', 'hidden', 'ownFollow'];
		const rows = ids.map((id, i) => ({ id, type: i === 0 ? 'reply' : i === 5 ? 'follow' : 'reaction', reaction: '👍', noteId: id, notifierId: actor.id, createdAt: new Date().toISOString() } as MiNotification));
		f.notifications.getNotifications.mockResolvedValue(rows);
		f.notifications.getNotification.mockImplementation(async (_user, id) => rows.find(row => row.id === id) ?? null);
		f.packer.packMany.mockImplementation(async rows => rows.map(row => ({ ...row, user: actor, note: { user: actor } })) as never);
		f.reads.state.mockImplementation(async (_user, ids = []) => ({ unreadCount: 99, changed: false, isRead: ids.map(() => false) }));
		f.notes.peerNotes.mockImplementation(async request => ({ notes: [{ id: request.noteId, conversationUri: request.conversationUri } as PrivateWireNote], head: null, next: null, scannedThrough: null, observedAt: '' }));
		f.db.getRepository.mockReturnValue({ findBy: async () => [actor, { id: 'remoteViewer', uri: 'https://r.example/users/viewer', username: 'viewer', host: 'r.example' }] } as never);
		const credential = { placementActorId: 'viewer' };
		const refs = await f.service.peerReferences(credential);
		expect(refs.items.map(item => item.id)).toEqual(['child', 'mine']);
		const page = await f.service.peer('query', credential);
		expect(page.items.map(item => item.id)).toEqual(['child', 'mine']);
		expect(page.unreadCount).toBe(2);
		expect(page.items.every(item => item.recipientActorUri === 'https://r.example/users/viewer')).toBe(true);
		expect(f.notes.peerNotes).toHaveBeenCalledWith({ ...credential, mode: 'show', noteId: 'child', conversationUri: 'https://g.example/notes/child' });
		await f.service.peer('read', { ...credential, ids: ['mine', 'other'] });
		expect(f.notifications.readNotifications).toHaveBeenLastCalledWith('remoteViewer', ['mine']);
		await f.service.peer('read-all', credential);
		expect(f.notifications.readNotifications).toHaveBeenLastCalledWith('remoteViewer', ['child', 'mine']);
		expect(f.placements.resolveActor).toHaveBeenCalledWith('viewer', f.db.manager);
		expect(f.notifications.readAllNotification).not.toHaveBeenCalled();
		await expect(f.service.peer('accept-follow', credential)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		await expect(f.service.peer('query', { ...credential, channelActorId: 'other' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('sends a bodyless hint only to an active local recipient', async () => {
		const f = fixture();
		const existsBy = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		f.db.getRepository.mockReturnValue({ existsBy } as never);
		await f.service.receiveGuestHint('absent');
		expect(f.events.publishMainStream).not.toHaveBeenCalled();
		await f.service.receiveGuestHint('viewer');
		expect(f.events.publishMainStream).toHaveBeenCalledExactlyOnceWith('viewer', 'gridspaceNotificationsChanged');
	});
	test('filters home-side mutes from guest references, counts and bulk reads', async () => {
		const f = fixture('client');
		const summary = { origin: 'https://r.example', recipientId: 'remoteViewer', complete: true, items: ['visible', 'muted'].map(id => ({
			id, createdAt: '2026-01-01T00:00:00Z', isRead: false, actors: [{ uri: 'https://r.example/users/' + id, host: 'r.example', name: null, username: id }],
		})) };
		f.links.json.mockImplementation(async (path, body) => {
			if (path.endsWith('/references')) return summary;
			expect(path).toBe('/gridspace/v1/notifications/read');
			expect(body).toEqual({ placementActorId: 'viewer', expectedRecipientId: 'remoteViewer', ids: ['visible'] });
			summary.items[0].isRead = true;
			return {};
		});
		f.notes.localActorAllows.mockImplementation(async (_user, actor) => !actor.uri.endsWith('/muted'));
		const refs = await f.service.remoteReferences(f.viewer, {}, true);
		expect(refs.items).toEqual([{ id: 'visible', createdAt: '2026-01-01T00:00:00Z' }]);
		expect((await f.service.remote(f.viewer, { countOnly: true }, 'query', true)).unreadCount).toBe(1);
		expect((await f.service.remote(f.viewer, {}, 'read-all', true)).unreadCount).toBe(0);
	});
	test('checks the current recipient, dedicated reply URI and parent actor on the home server', async () => {
		const f = fixture('source');
		const recipientActorUri = 'https://g.example/users/viewer';
		const author = { uri: 'https://r.example/users/author', host: 'r.example' };
		const note = { id: 'child', uri: 'https://r.example/notes/child', conversationUri: 'https://r.example/notes/child', multiNoteKind: 'conversation-reply', includeDefault: false,
			localOnly: true, author, filterActors: [author, { uri: recipientActorUri, host: 'g.example' }] };
		vi.spyOn(f.service, 'remoteReferences').mockResolvedValue({ origin: 'https://r.example', recipientId: 'remoteViewer', unreadCount: 1, complete: true, items: [{ id: 'notice', createdAt: '2026-01-01T00:00:00Z' }] });
		const response = { items: [{ type: 'reply', id: 'notice', user: author, note, recipientActorUri }], origin: 'https://r.example', recipientId: 'remoteViewer' };
		f.links.json.mockResolvedValue(response);
		expect((await f.service.remote(f.viewer, {}, 'query', true)).items.map(item => item.id)).toEqual(['notice']);
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/notifications/query', expect.objectContaining({ placementActorId: 'viewer' }));
		expect(f.links.privateLink).not.toHaveBeenCalled();
		for (const patch of [{ recipientActorUri: 'https://g.example/users/wrong' }, { note: { ...note, filterActors: [author] } }, { note: { ...note, uri: 'https://wrong.example/notes/child' } }]) {
			f.links.json.mockResolvedValue({ ...response, items: [{ ...response.items[0], ...patch }] });
			await expect(f.service.remote(f.viewer, {}, 'query', true)).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
		}
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
