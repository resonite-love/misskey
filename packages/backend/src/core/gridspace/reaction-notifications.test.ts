/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { ModuleRef } from '@nestjs/core';
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiUser } from '@/models/User.js';
import { MiGridspaceReactionNotification } from '@/models/Gridspace.js';
import { NotificationService } from '@/core/NotificationService.js';
import { GridspaceReactionDeliveryService } from './GridspaceReactionDeliveryService.js';
import { GridspaceReactionNotificationService } from './GridspaceReactionNotificationService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { requestGridspacePeer } from './peer-client.js';

vi.mock('./peer-client.js', () => ({ requestGridspacePeer: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function fixture() {
	vi.stubEnv('REACTION_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const config = { url: 'https://g.example', gridspace: { enabled: true, communityId: 'reactions', peerUrl: 'https://r.example', keyId: 'v1', secretEnv: 'REACTION_TEST_KEY' } } as Config;
	const db = mockDeep<DataSource>(); const manager = mockDeep<EntityManager>();
	const runner = mockDeep<QueryRunner>(); runner.query.mockResolvedValue([{ locked: true }]);
	runner.release.mockResolvedValue();
	db.createQueryRunner.mockReturnValue(runner);
	db.transaction.mockImplementation((async (work: (manager: EntityManager) => unknown) => work(manager)) as never);
	const queue = mockDeep<Repository<MiGridspaceReactionNotification>>();
	const notes = mockDeep<Repository<MiNote>>(); const users = mockDeep<Repository<MiUser>>();
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiNote ? notes : entity === MiUser ? users : queue) as never);
	const modules = mockDeep<ModuleRef>(); const notifications = mockDeep<NotificationService>();
	const search = mockDeep<GridspaceSearchService>();
	const query = { andWhere: vi.fn().mockReturnThis() };
	search.noteQuery.mockReturnValue(query as never);
	modules.get.mockImplementation(((service: unknown) => service === NotificationService ? notifications : search) as never);
	const note = { id: 'local', userId: 'author', userHost: null, localOnly: true, channelId: null, uri: null } as MiNote;
	const item = { reactionId: 'reaction', noteId: 'cached', notifierId: 'actor', reaction: ':wave:', createdAt: new Date(), retryAt: new Date(), attempts: 0 } as MiGridspaceReactionNotification;
	notes.findOneBy.mockResolvedValue(note); queue.find.mockResolvedValue([item]); db.query.mockResolvedValue([{ exists: 1 }]);
	const actor = { id: 'remote-actor', uri: 'https://r.example/users/actor', host: 'r.example', isDeleted: false, isSuspended: false } as MiUser;
	users.findOneBy.mockResolvedValue(actor); search.read.mockResolvedValue([note]);
	const service = new GridspaceReactionNotificationService(db, config, modules);
	return { service, db, config, manager, runner, queue, notes, users, modules, notifications, search, note, item, actor };
}

test('queues primary/additional local-only peer reactions in the same transaction, never ordinary federation', async () => {
	const f = fixture(); const delivery = new GridspaceReactionDeliveryService(f.db, f.config, mockDeep());
	const remote = { ...f.note, userHost: 'r.example', uri: 'https://r.example/notes/source' };
	const record = { id: 'reaction', userId: 'actor', reaction: ':wave:' };
	await delivery.mutate(remote, async () => undefined, record);
	expect(f.manager.insert).toHaveBeenCalledWith(MiGridspaceReactionNotification, expect.objectContaining({ reactionId: record.id, notifierId: record.userId, noteId: remote.id }));
	f.manager.insert.mockClear();
	for (const note of [{ ...remote, localOnly: false }, { ...remote, channelId: 'channel' }, f.note, { ...remote, userHost: 'other.example' }]) {
		await delivery.mutate(note, async () => undefined, record);
	}
	expect(f.manager.insert).not.toHaveBeenCalled();
	await expect(delivery.mutate(remote, async () => { throw new Error('write failed'); }, record)).rejects.toThrow();
	expect(f.manager.insert).not.toHaveBeenCalled();
});

test('delivers only live reactions, retries a lost acknowledgement with the same identity', async () => {
	const f = fixture(); f.notes.findOneBy.mockResolvedValue({ ...f.note, userHost: 'r.example', uri: 'https://r.example/notes/source' });
	vi.mocked(requestGridspacePeer).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true });
	await f.service.flush();
	expect(f.queue.delete).not.toHaveBeenCalled();
	expect(f.queue.update).toHaveBeenCalledWith('reaction', expect.objectContaining({ attempts: 1 }));
	await f.service.flush();
	expect(requestGridspacePeer).toHaveBeenLastCalledWith(expect.anything(), '/gridspace/v1/reactions/notify', expect.objectContaining({ reactionId: 'reaction', actorId: 'actor', noteId: 'source', reaction: ':wave@g.example:' }), 4096, expect.any(Number));
	expect(f.queue.delete).toHaveBeenCalledWith('reaction');
});

test.each(['cancelled', 'deleted', 'expired', 'external', 'federated'])('discards %s queued work without delivering', async kind => {
	const f = fixture(); f.notes.findOneBy.mockResolvedValue({ ...f.note, userHost: 'r.example', uri: 'https://r.example/notes/source' });
	if (kind === 'cancelled') f.db.query.mockResolvedValue([]);
	if (kind === 'deleted') f.notes.findOneBy.mockResolvedValue(null);
	if (kind === 'expired') f.item.createdAt = new Date(Date.now() - 86400001);
	if (kind === 'external') f.notes.findOneBy.mockResolvedValue({ ...f.note, userHost: 'other.example' });
	if (kind === 'federated') f.notes.findOneBy.mockResolvedValue({ ...f.note, localOnly: false });
	await f.service.flush();
	expect(requestGridspacePeer).not.toHaveBeenCalled(); expect(f.queue.delete).toHaveBeenCalledWith('reaction');
});

test('concurrent workers cannot deliver the same queue and bad acknowledgements remain retryable', async () => {
	const f = fixture(); f.runner.query.mockResolvedValue([{ locked: false }]);
	await f.service.flush(); expect(f.queue.find).not.toHaveBeenCalled();
	f.runner.query.mockResolvedValue([{ locked: true }]);
	f.notes.findOneBy.mockResolvedValue({ ...f.note, userHost: 'r.example', uri: 'https://r.example/notes/source' });
	vi.mocked(requestGridspacePeer).mockResolvedValue({ ok: false });
	await f.service.flush(); expect(f.queue.delete).not.toHaveBeenCalled(); expect(f.queue.update).toHaveBeenCalled();
});

const input = () => ({ reactionId: 'reaction', actorId: 'actor', noteId: 'local', reaction: ':wave@r.example:', createdAt: Date.now() });

test('notifies the actual local author with canonical emoji, source-side visibility and stable deduplication', async () => {
	const f = fixture();
	await f.service.receive(input()); await f.service.receive(input());
	expect(f.search.noteQuery).toHaveBeenCalledWith(f.actor, { query: '' }, false, true);
	expect(f.notifications.createReactionNotificationOnce).toHaveBeenCalledWith(f.note, ':wave@r.example:', f.actor.id, expect.stringMatching(/^[0-9a-f]{64}$/));
	expect(f.notifications.createReactionNotificationOnce.mock.calls[0][3]).toBe(f.notifications.createReactionNotificationOnce.mock.calls[1][3]);
});

test.each(['invisible', 'deleted', 'external', 'channel', 'federated', 'suspended', 'wrong-actor', 'expired', 'future'])('does not notify for %s input', async kind => {
	const f = fixture(); const request = input();
	if (kind === 'invisible') f.search.read.mockResolvedValue([]);
	if (kind === 'deleted') f.notes.findOneBy.mockResolvedValue(null);
	if (kind === 'external') f.note.userHost = 'other.example';
	if (kind === 'channel') f.note.channelId = 'channel';
	if (kind === 'federated') f.note.localOnly = false;
	if (kind === 'suspended') f.actor.isSuspended = true;
	if (kind === 'wrong-actor') f.actor.uri = 'https://other.example/users/actor';
	if (kind === 'expired') request.createdAt -= 86400001;
	if (kind === 'future') request.createdAt += 60001;
	expect(await f.service.receive(request)).toEqual({ ok: true });
	expect(f.notifications.createReactionNotificationOnce).not.toHaveBeenCalled();
});

test('a Redis failure does not acknowledge delivery so the sender can retry', async () => {
	const f = fixture(); f.notifications.createReactionNotificationOnce.mockRejectedValue(new Error('redis unavailable'));
	await expect(f.service.receive(input())).rejects.toThrow('redis unavailable');
});
