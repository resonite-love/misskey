/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceReplyReceipt } from '@/models/Gridspace.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import PrivateReplyEndpoint from '@/server/api/endpoints/gridspace/private-reply.js';
import { GridspaceReplyService } from './GridspaceReplyService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { canSelfRenote, type ReplyPeerRequest } from './reply-protocol.js';

function fixture() {
	const db = mockDeep<DataSource>(), manager = mockDeep<EntityManager>();
	const links = mockDeep<GridspaceLinkService>(), reader = mockDeep<GridspacePrivateService>();
	const create = mockDeep<NoteCreateService>(), auth = mockDeep<GridspaceChannelAuthService>();
	const user = { id: 'old', username: 'author', host: null, uri: null, avatarId: null } as MiUser;
	const parent = { id: 'parent', channelId: null, visibility: 'followers', userId: 'old', visibleUserIds: [], localOnly: true, renoteId: null, text: 'Original', cw: null, fileIds: [], hasPoll: false } as MiNote;
	const link = { id: 'link', generation: 1, localUserId: user.id, initiator: false };
	let receipt: MiGridspaceReplyReceipt | null = null;
	const noteRepo = { existsBy: vi.fn(async () => true) };
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiUser ? { findOneBy: async () => user } : entity === MiGridspaceReplyReceipt ? { findOneBy: async () => receipt } : entity === MiNote ? noteRepo : {}) as DataSource['getRepository']);
	links.authorizePrivate.mockResolvedValue(link as never);
	links.hasReplyScope.mockResolvedValue(true); links.hasActionScope.mockResolvedValue(true);
	reader.readableSourceNote.mockImplementation(async () => parent);
	create.fetchAndCreate.mockImplementation(async (_user, data) => {
		await data.gridspaceReply!.beforeInsert(manager);
		receipt = { requestHash: data.gridspaceReply!.requestHash, noteId: 'created' } as MiGridspaceReplyReceipt;
		return { id: 'created' } as MiNote;
	});
	const service = new GridspaceReplyService(db, { url: 'https://r.example' } as Config, links, reader, create, mockDeep<UserEntityService>(), auth);
	const input: ReplyPeerRequest = { action: 'send', renoteId: 'parent', expectedActorUri: 'https://r.example/users/old', requestId: '00000000-0000-4000-8000-000000000001', accessToken: 'token', linkId: 'link', localUserId: 'grid-user', generation: 1, pairId: 'pair' };
	const rate = vi.fn(async () => {});
	return { service, run: (extra: Partial<ReplyPeerRequest> = {}) => service.peerReply({ ...input, ...extra }, rate), input, user, parent, link, create, auth, links, reader, manager, noteRepo, rate };
}

test('the REST endpoint accepts a renote-only target and rejects a missing or malformed target', async () => {
	const replies = mockDeep<GridspaceReplyService>();
	const endpoint = new PrivateReplyEndpoint(replies, mockDeep<GridspaceLinkService>());
	const viewer = { id: 'grid-user' } as MiLocalUser;
	await expect(endpoint.exec({ renoteId: 'parent' }, viewer, null)).resolves.toBeUndefined();
	expect(replies.reply).toHaveBeenCalledWith(viewer, expect.objectContaining({ renoteId: 'parent', action: 'prepare' }));
	for (const input of [{}, { renoteId: '../private' }]) await expect(endpoint.exec(input, viewer, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
});

test.each([true, false])('old-account self-renote keeps followers-only visibility and localOnly=%s', async localOnly => {
	const f = fixture(); f.parent.localOnly = localOnly;
	expect(canSelfRenote(f.parent, f.user.id)).toBe(true);
	expect(await f.run()).toMatchObject({ createdNoteId: 'created', account: { uri: 'https://r.example/users/old' }, visibility: 'followers', localOnly });
	expect(f.create.fetchAndCreate).toHaveBeenCalledWith(f.user, expect.objectContaining({ renoteId: 'parent', replyId: null, channelId: null, text: null, cw: null, visibility: 'followers', visibleUserIds: [], localOnly, apMentions: [] }));
	expect(f.links.lockReplyAuthorization).toHaveBeenCalledWith(f.input, f.manager, 'write:gridspace-reply');
	expect(f.auth.source).not.toHaveBeenCalled();
	await f.run(); expect(f.create.fetchAndCreate).toHaveBeenCalledTimes(1); expect(f.rate).toHaveBeenCalledTimes(1);
	f.noteRepo.existsBy.mockResolvedValue(false);
	await expect(f.run()).rejects.toMatchObject({ code: 'REPLY_DELETED' });
});

test('rejects another author, public/home/direct notes, channels and pure renote wrappers', async () => {
	for (const changes of [{ userId: 'other' }, { visibility: 'public' }, { visibility: 'home' }, { visibility: 'specified' }, { channelId: 'channel' }, { renoteId: 'original', text: null }]) {
		const f = fixture(); Object.assign(f.parent, changes);
		expect(canSelfRenote(f.parent, f.user.id)).toBe(false);
		await expect(f.run()).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
		expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
	}
});

test('self-renotes cannot attach commentary or files, select another author, or run in reverse', async () => {
	for (const changes of [{ text: 'quote' }, { cw: '' }, { fileIds: ['file'] }, { poll: { choices: ['A', 'B'], multiple: false, expiresAt: null } }]) {
		const f = fixture();
		await expect(f.run(changes)).rejects.toMatchObject({ code: 'REPLY_REJECTED' });
		expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
	}
	const f = fixture();
	await expect(f.run({ expectedActorUri: 'https://g.example/users/new' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	f.link.initiator = true;
	await expect(f.run()).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
});

test('read permission alone does not allow a self-renote and commit rechecks grant and target', async () => {
	const f = fixture(); f.links.hasReplyScope.mockResolvedValue(false);
	expect(await f.run({ action: 'prepare' })).toMatchObject({ canReply: false });
	await expect(f.run()).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
	for (const changes of [null, { userId: 'other' }, { visibility: 'specified' }, { localOnly: false }]) {
		const race = fixture();
		race.reader.readableSourceNote.mockResolvedValueOnce(race.parent).mockResolvedValue(changes === null ? null : { ...race.parent, ...changes });
		await expect(race.run()).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
	}
	const revoked = fixture(); revoked.links.lockReplyAuthorization.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
	await expect(revoked.run()).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
});

test('destination uses its linked credential and old author rather than the GridSpace channel actor', async () => {
	const f = fixture();
	f.links.privateLink.mockResolvedValue({ initiator: true } as never);
	f.links.privateCredential.mockReturnValue({ accessToken: 'bound', localUserId: 'grid-user' });
	f.reader.notes.mockResolvedValue({ notes: [f.parent] } as never);
	await f.service.reply({ id: 'grid-user' } as MiLocalUser, f.input);
	expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/private/reply', expect.objectContaining({ accessToken: 'bound', renoteId: 'parent', expectedActorUri: 'https://r.example/users/old' }));
	expect(f.auth.destination).not.toHaveBeenCalled();
	expect(f.links.checkPrivateUnchanged).toHaveBeenCalledOnce();
	f.links.privateLink.mockResolvedValue({ initiator: false } as never);
	await expect(f.service.reply({ id: 'old' } as MiLocalUser, f.input)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
});
