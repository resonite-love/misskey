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
import { MiChannel } from '@/models/Channel.js';
import { MiGridspaceReplyReceipt } from '@/models/Gridspace.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GridspaceReplyService } from './GridspaceReplyService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import type { ReplyPeerRequest } from './reply-protocol.js';

function fixture(guest = true) {
	const db = mockDeep<DataSource>(), manager = mockDeep<EntityManager>();
	const links = mockDeep<GridspaceLinkService>(), reader = mockDeep<GridspacePrivateService>();
	const create = mockDeep<NoteCreateService>(), auth = mockDeep<GridspaceChannelAuthService>();
	const user = { id: guest ? 'grid-remote' : 'old-local', username: 'author', host: guest ? 'g.example' : null, uri: guest ? 'https://g.example/users/current' : null, avatarId: null } as MiUser;
	const parent = { id: 'parent', channelId: 'channel', visibility: 'public', userId: 'other', visibleUserIds: [], localOnly: true, renoteId: null, text: 'Original', cw: null, fileIds: [], hasPoll: false } as MiNote;
	const receipt = { value: null as MiGridspaceReplyReceipt | null };
	const channelRepo = { findOneBy: vi.fn(async () => ({ id: 'channel', isArchived: false })), findOne: vi.fn(async () => ({ id: 'channel' })) };
	const noteRepo = { existsBy: vi.fn(async () => true) };
	const receiptRepo = { findOneBy: vi.fn(async () => receipt.value) };
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiChannel ? channelRepo : entity === MiUser ? { findOneBy: async () => user } : entity === MiGridspaceReplyReceipt ? receiptRepo : entity === MiNote ? noteRepo : { countBy: async () => 1 }) as DataSource['getRepository']);
	manager.getRepository.mockImplementation(db.getRepository);
	auth.source.mockResolvedValue(user);
	links.authorizePrivate.mockResolvedValue({ id: 'link', generation: 1, localUserId: user.id, initiator: false } as never);
	links.hasChannelScope.mockResolvedValue(true); links.hasReplyScope.mockResolvedValue(true); links.hasActionScope.mockResolvedValue(true);
	reader.readableSourceNote.mockImplementation(async () => parent);
	create.fetchAndCreate.mockImplementation(async (_user, data) => {
		await data.gridspaceReply!.beforeInsert(manager);
		receipt.value = { userId: user.id, requestId: data.gridspaceReply!.requestId, requestHash: data.gridspaceReply!.requestHash, noteId: 'created' } as MiGridspaceReplyReceipt;
		return { id: 'created' } as MiNote;
	});
	const service = new GridspaceReplyService(db, { url: 'https://r.example' } as Config, links, reader, create, mockDeep<UserEntityService>(), auth);
	const input: ReplyPeerRequest = { action: 'send', channelId: 'channel', renoteId: parent.id, requestId: '00000000-0000-4000-8000-000000000001', ...(guest ? { channelActorId: 'current' } : { accessToken: 'secret', linkId: 'link', localUserId: 'current', generation: 1, pairId: 'pair' }) };
	const rate = vi.fn(async () => {});
	return { service, run: (extra: Partial<ReplyPeerRequest> = {}) => service.peerReply({ ...input, ...extra }, rate), input, user, parent, create, auth, links, reader, manager, channelRepo, noteRepo, rate };
}

test.each([true, false])('creates an in-channel renote using the authorized identity (grid-only=%s)', async guest => {
	const f = fixture(guest);
	expect(await f.run()).toMatchObject({ createdNoteId: 'created' });
	expect(f.create.fetchAndCreate).toHaveBeenCalledWith(f.user, expect.objectContaining({ renoteId: 'parent', replyId: null, channelId: 'channel', text: null, visibility: 'public', localOnly: true, visibleUserIds: [] }));
	if (guest) expect(f.auth.source).toHaveBeenCalledWith('current', f.manager);
	else expect(f.links.lockReplyAuthorization).toHaveBeenCalledWith(f.input, f.manager, 'write:gridspace-channel');
});

test('quote retains text, CW, attachments and poll on the same channel', async () => {
	const f = fixture();
	await f.run({ text: 'Comment', cw: 'Warning', fileIds: ['file'], poll: { choices: ['A', 'B'], multiple: false, expiresAt: null } });
	expect(f.create.fetchAndCreate).toHaveBeenCalledWith(f.user, expect.objectContaining({ renoteId: 'parent', replyId: null, text: 'Comment', cw: 'Warning', fileIds: ['file'], poll: { choices: ['A', 'B'], multiple: false, expiresAt: null } }));
});

test('duplicate delivery returns the receipt and different quote content conflicts', async () => {
	const f = fixture();
	await f.run(); await f.run();
	expect(f.create.fetchAndCreate).toHaveBeenCalledTimes(1); expect(f.rate).toHaveBeenCalledTimes(1);
	await expect(f.run({ text: 'Changed' })).rejects.toMatchObject({ code: 'REPLY_CONFLICT' });
	f.noteRepo.existsBy.mockResolvedValue(false);
	await expect(f.run()).rejects.toMatchObject({ code: 'REPLY_DELETED' });
});

test('rejects channel escape, private targets, pure renote targets and incompatible requests', async () => {
	for (const change of [{ channelId: 'another' }, { visibility: 'followers' }, { visibility: 'specified' }, { renoteId: 'another', text: null }]) {
		const f = fixture(); Object.assign(f.parent, change);
		await expect(f.run()).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
		expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
	}
	for (const input of [{ channelId: undefined }, { noteId: 'reply' }]) {
		const f = fixture();
		await expect(f.run(input)).rejects.toMatchObject({ code: 'channelId' in input ? 'AUTHORIZATION_REVOKED' : 'REPLY_UNAVAILABLE' });
		expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
	}
});

test('checks target visibility, channel archive and authorization again at insertion', async () => {
	for (const reason of ['deleted', 'moved', 'private', 'archived', 'revoked'] as const) {
		const f = fixture();
		if (reason === 'deleted') f.reader.readableSourceNote.mockResolvedValueOnce(f.parent).mockResolvedValue(null);
		if (reason === 'moved') f.reader.readableSourceNote.mockResolvedValueOnce(f.parent).mockResolvedValue({ ...f.parent, channelId: 'another' });
		if (reason === 'private') f.reader.readableSourceNote.mockResolvedValueOnce(f.parent).mockResolvedValue({ ...f.parent, visibility: 'specified' });
		if (reason === 'archived') f.channelRepo.findOne.mockResolvedValue(null as never);
		if (reason === 'revoked') f.auth.source.mockImplementation(async (_id, manager) => { if (manager) throw new GridspaceLinkError('AUTHORIZATION_REVOKED'); return f.user; });
		await expect(f.run()).rejects.toMatchObject({ code: reason === 'revoked' ? 'AUTHORIZATION_REVOKED' : 'REPLY_UNAVAILABLE' });
	}
});

test('normal channel replies still set replyId and require content', async () => {
	const f = fixture();
	await expect(f.run({ renoteId: undefined, noteId: 'parent' })).rejects.toMatchObject({ code: 'REPLY_REJECTED' });
	await f.run({ renoteId: undefined, noteId: 'parent', text: 'Reply' });
	expect(f.create.fetchAndCreate).toHaveBeenCalledWith(f.user, expect.objectContaining({ replyId: 'parent', renoteId: null }));
});

test('destination forwards the current GridSpace actor and validates its own access first', async () => {
	const f = fixture(); const check = vi.fn();
	f.auth.destination.mockResolvedValue({ credential: { channelActorId: 'current' }, check } as never);
	f.reader.notes.mockResolvedValue({ notes: [f.parent] } as never);
	await f.service.reply({ id: 'current' } as MiLocalUser, f.input, true);
	expect(f.auth.destination).toHaveBeenCalledWith({ id: 'current' }, true);
	expect(f.reader.notes).toHaveBeenCalledWith({ id: 'current' }, { mode: 'show', noteId: 'parent', channelId: 'channel' }, 1);
	expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/private/reply', expect.objectContaining({ channelActorId: 'current', channelId: 'channel', renoteId: 'parent' }));
	expect(check).toHaveBeenCalledOnce();
	f.reader.notes.mockResolvedValue({ notes: [] } as never); f.links.json.mockClear();
	await expect(f.service.reply({ id: 'current' } as MiLocalUser, f.input, true)).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
	await expect(f.service.reply({ id: 'current' } as MiLocalUser, f.input, false)).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
	expect(f.links.json).not.toHaveBeenCalled();
});
