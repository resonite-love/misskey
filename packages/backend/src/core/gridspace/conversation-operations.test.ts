/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiNote } from '@/models/Note.js';
import type { MiRemoteUser } from '@/models/User.js';
import { PollService } from '@/core/PollService.js';
import { MiPoll } from '@/models/Poll.js';
import { MiPollVote } from '@/models/PollVote.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspaceReplyService } from './GridspaceReplyService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import type { NoteCreateService } from '@/core/NoteCreateService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GridspacePlacementActionService } from './GridspacePlacementActionService.js';
import { GridspacePlacementService } from './GridspacePlacementService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { dedicatedOriginal, originNoteId } from './conversation-protocol.js';
import { supportsGridspaceReactions, supportsGridspaceChannelReactions } from './reaction-protocol.js';
import type { GridspacePeerConfig } from './peer-protocol.js';

const origin = 'https://source.example';
const peerOrigin = 'https://home.example';
const root = { id: 'root', userId: 'owner', userHost: null, channelId: null, uri: null, localOnly: true,
	visibility: 'public', multiNoteKind: 'root', includeDefault: false, multiNoteRootId: null } as MiNote;
const guest = { id: 'guest', host: 'home.example', uri: peerOrigin + '/users/current' } as MiRemoteUser;
const reply = { ...root, id: 'child', multiNoteKind: 'conversation-reply', multiNoteRootId: 'root', userId: guest.id, userHost: guest.host } as MiNote;
const input = { noteId: 'child', conversationUri: origin + '/notes/child', placementActorId: 'current' };

function fixture(note: MiNote = reply) {
	const db = mockDeep<DataSource>();
	const modules = mockDeep<ModuleRef>();
	const placements = mockDeep<GridspacePlacementService>();
	const search = mockDeep<GridspaceSearchService>();
	const remove = mockDeep<NoteDeleteService>();
	const query = { andWhere: vi.fn().mockReturnThis(), setQueryRunner: vi.fn().mockReturnThis(), getOne: vi.fn(async () => note) };
	search.noteQuery.mockReturnValue(query as never);
	search.read.mockResolvedValue([note]);
	placements.resolveActor.mockResolvedValue(guest);
	placements.hasPeerCapability.mockResolvedValue(true);
	placements.peerEnabled.mockResolvedValue(true);
	modules.get.mockImplementation(((type: unknown) => type === GridspacePlacementService ? placements : type === GridspaceSearchService ? search : remove) as ModuleRef['get']);
	const links = mockDeep<GridspaceLinkService>();
	const service = new GridspacePlacementActionService(db, { url: origin, gridspace: { peerUrl: peerOrigin } } as Config, modules, links);
	return { service, db, placements, search, remove, query };
}

describe('placement actor operations', () => {
	test('only recognizes local, dedicated originals and their origin-hosted children', () => {
		expect([root, reply].map(dedicatedOriginal)).toEqual([true, true]);
		for (const candidate of [{ ...root, uri: peerOrigin + '/notes/mirror' }, { ...reply, multiNoteRootId: null },
			{ ...root, multiNoteKind: null }, { ...root, includeDefault: true }]) expect(dedicatedOriginal(candidate)).toBe(false);
		const peer = { origin, peerOrigin } as GridspacePeerConfig;
		expect(supportsGridspaceReactions(root, peer)).toBe(false);
		expect(supportsGridspaceReactions(reply, peer)).toBe(false);
		expect(supportsGridspaceChannelReactions(reply, peer)).toBe(true);
		expect(supportsGridspaceReactions({ ...root, includeDefault: true }, peer)).toBe(true);
	});

	test('canonical names bind the requested origin and target ID', () => {
		expect(originNoteId(origin + '/notes/abc123/activity', origin)).toBe('abc123');
		for (const uri of [origin + '/notes/foo?q=1', origin + '/notes/foo#x', origin + '/notes/%66oo', peerOrigin + '/notes/foo']) {
			expect(originNoteId(uri, origin)).toBeNull();
		}
	});

	test('public detail survives unlisting and never authorizes replies or uploads', async () => {
		const f = fixture();
		expect((await f.service.source(input, 'read')).note).toBe(reply);
		expect(f.placements.authorizeConversationWrite).not.toHaveBeenCalled();
		f.search.read.mockResolvedValueOnce([reply]).mockResolvedValueOnce([root]).mockResolvedValueOnce([reply]).mockResolvedValueOnce([root]);
		f.placements.authorizeConversationWrite.mockRejectedValue(new Error('archived'));
		for (const purpose of ['reply', 'upload'] as const) {
			await expect(f.service.source(input, purpose)).rejects.toThrow('archived');
			expect(f.placements.authorizeConversationWrite).toHaveBeenCalledWith(guest, root, purpose, undefined);
		}
	});

	test('a transaction rechecks actor and write authority at the root origin', async () => {
		const f = fixture();
		const manager = mockDeep<EntityManager>();
		f.query.getOne.mockResolvedValueOnce(reply).mockResolvedValueOnce(root);
		f.search.read.mockResolvedValueOnce([reply]).mockResolvedValueOnce([root]);
		await f.service.source(input, 'reply', manager);
		expect(f.placements.resolveActor).toHaveBeenCalledWith('current', manager);
		expect(f.placements.authorizeConversationWrite).toHaveBeenCalledWith(guest, root, 'reply', manager);
	});

	test('ordinary reactions stay at actor home while localOnly polls accept checked guest votes', async () => {
		const f = fixture({ ...root, includeDefault: true });
		await expect(f.service.source(input, 'reaction')).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		await expect(f.service.source(input, 'vote')).resolves.toMatchObject({ user: guest });
		await expect(fixture({ ...root, includeDefault: true, localOnly: false }).service.source(input, 'vote')).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
	});

	test('rejects credential mixing, other paths, and disabled writes', async () => {
		const f = fixture();
		for (const extra of [{ linkId: 'linked' }, { channelActorId: 'legacy' }, { conversationUri: peerOrigin + '/notes/child' }, { noteId: 'other' }]) {
			await expect(f.service.source({ ...input, ...extra }, 'read')).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		}
		expect(f.placements.resolveActor).not.toHaveBeenCalled();
		f.placements.peerEnabled.mockResolvedValue(false);
		await expect(f.service.source(input, 'vote')).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});

	test('author deletion rechecks saved reply provenance without loading a parent or listing', async () => {
		const f = fixture();
		const manager = mockDeep<EntityManager>();
		f.db.manager.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce(reply);
		manager.findOneBy.mockResolvedValue(null);
		manager.findOne.mockResolvedValue(reply);
		f.remove.delete.mockImplementation(async (_user, _note, _quiet, _deleter, guard) => { await guard!(manager); });
		await expect(f.service.peerDeleteReply({ actorId: 'current', canonicalUri: input.conversationUri, requestId: 'req' })).resolves.toEqual({ deleted: true });
		expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ where: expect.objectContaining({ userId: guest.id, multiNoteKind: 'conversation-reply', includeDefault: false }) }));
		expect(manager.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ noteId: reply.id, userId: guest.id, requestId: 'req' }));
		expect(f.placements.authorizeConversationWrite).not.toHaveBeenCalled();
		const receipt = manager.insert.mock.calls[0][1];
		f.db.manager.findOneBy.mockResolvedValue(receipt as never);
		await expect(f.service.peerDeleteReply({ actorId: 'current', canonicalUri: input.conversationUri, requestId: 'req' })).resolves.toEqual({ deleted: true });
		await expect(f.service.peerDeleteReply({ actorId: 'current', canonicalUri: origin + '/notes/other', requestId: 'req' })).rejects.toMatchObject({ code: 'REPLY_CONFLICT' });
		expect(f.remove.delete).toHaveBeenCalledTimes(1);
	});

	test('a guest child uses its local parent and original root with the same viewer through commit', async () => {
		const placements = mockDeep<GridspacePlacementActionService>();
		placements.source.mockResolvedValue({ user: guest, note: { ...reply, renoteId: null } });
		const db = mockDeep<DataSource>();
		db.getRepository.mockReturnValue({ findOneBy: async () => null } as never);
		const manager = mockDeep<EntityManager>();
		const create = mockDeep<NoteCreateService>();
		create.fetchAndCreate.mockImplementation(async (_actor, options) => {
			await options.gridspaceReply!.beforeInsert(manager);
			return { ...reply, id: 'grandchild' };
		});
		const links = mockDeep<GridspaceLinkService>();
		const service = new GridspaceReplyService(db, { url: origin } as Config, links, mockDeep<GridspacePrivateService>(),
			create, mockDeep<UserEntityService>(), mockDeep<GridspaceChannelAuthService>(), placements);
		const result = await service.peerReply({ ...input, action: 'send', requestId: 'req', text: 'hello' }, async () => {});
		expect(result.createdNoteId).toBe('grandchild');
		expect(create.fetchAndCreate).toHaveBeenCalledWith(guest, expect.objectContaining({
			replyId: reply.id, multiNoteConversationRootId: root.id, visibility: 'public', localOnly: true, channelId: null,
		}));
		expect(placements.source).toHaveBeenCalledWith(expect.objectContaining(input), 'reply', manager);
		expect(links.authorizePrivate).not.toHaveBeenCalled();
	});

	test('standard paired mirror votes store authoritative counts and personal choices without another AP delivery', async () => {
		const manager = mockDeep<EntityManager>();
		const action = vi.fn(async () => ({ note: { poll: { choices: [{ text: 'one', votes: 1, isVoted: true }, { text: 'two', votes: 2, isVoted: false }] } } }));
		const poll = { noteId: 'mirror', choices: ['one', 'two'], votes: [0, 3] } as MiPoll;
		manager.findOne.mockResolvedValue(poll);
		const insert = { insert: vi.fn().mockReturnThis(), into: vi.fn().mockReturnThis(), values: vi.fn().mockReturnThis(), orIgnore: vi.fn().mockReturnThis(), execute: vi.fn() };
		manager.createQueryBuilder.mockReturnValue(insert as never);
		const service = Object.assign(Object.create(PollService.prototype), { config: { gridspace: { enabled: true, peerUrl: origin } },
			modules: { get: () => ({ action }) }, db: { transaction: (run: (tx: EntityManager) => Promise<void>) => run(manager) },
			noteEntityService: { isVisibleForMe: async () => true }, userBlockingService: { checkBlocked: async () => false }, idService: { gen: () => 'v' } }) as PollService;
		const actor = { id: 'current', host: null } as MiLocalUser;
		const mirror = { ...root, id: 'mirror', uri: origin + '/notes/root', userHost: 'source.example', hasPoll: true, gridspaceShared: true, includeDefault: true };
		const guard = vi.fn(async () => {});
		await service.castVote(actor, mirror, 0, guard);
		expect(guard).toHaveBeenCalledWith(manager);
		expect(action).toHaveBeenCalledWith(actor, { action: 'vote', noteId: 'root', conversationUri: mirror.uri, choice: 0 });
		expect(manager.update).toHaveBeenCalledWith(MiPoll, { noteId: 'mirror' }, { votes: [1, 3] });
		expect(insert.into).toHaveBeenCalledWith(MiPollVote);
		expect(insert.values).toHaveBeenCalledWith([{ id: 'v', noteId: 'mirror', userId: 'current', choice: 0 }]);
		const denied = vi.fn(async () => { throw new Error('revoked'); });
		await expect(service.castVote(actor, mirror, 0, denied)).rejects.toThrow('revoked');
		expect(action).toHaveBeenCalledTimes(1);
	});

	test('losing the author or dedicated reply at the final check prevents deletion', async () => {
		const f = fixture();
		const manager = mockDeep<EntityManager>();
		f.db.manager.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce(reply);
		manager.findOneBy.mockResolvedValue(null);
		manager.findOne.mockResolvedValue(null);
		f.remove.delete.mockImplementation(async (_user, _note, _quiet, _deleter, guard) => { await guard!(manager); });
		await expect(f.service.peerDeleteReply({ actorId: 'current', canonicalUri: input.conversationUri, requestId: 'req' })).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		expect(manager.insert).not.toHaveBeenCalled();
	});
});
