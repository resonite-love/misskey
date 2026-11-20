/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { MiChannel } from '@/models/Channel.js';
import type { NoteCreateService } from '@/core/NoteCreateService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceReplyService } from './GridspaceReplyService.js';
import type { ReplyPeerRequest } from './reply-protocol.js';

function fixture() {
	const actor = { id: 'guest', username: 'guest', host: 'g.example', uri: 'https://g.example/users/guest', name: null, avatarId: null };
	const source = { id: 'source', allowRenoteToExternal: true, isArchived: false };
	const destination = { id: 'destination', isArchived: false };
	const parent = { id: 'parent', channelId: 'source', visibility: 'public', renoteId: null, text: 'source', fileIds: [], hasPoll: false };
	const channels = {
		findOneBy: vi.fn(async ({ id }) => id === source.id ? source : id === destination.id ? destination : null),
		findOne: vi.fn(async ({ where }) => {
			const value = where.id === source.id ? source : destination;
			return Object.entries(where).every(([key, expected]) => value[key as keyof typeof value] === expected) ? value : null;
		}),
	};
	const repo = { findOneBy: vi.fn(async () => null) };
	const manager = { getRepository: (type: unknown) => type === MiChannel ? channels : repo };
	const db = { ...manager } as unknown as DataSource;
	const links = { authorizePrivate: vi.fn(), hasActionScope: vi.fn() };
	const reader = { readableSourceNote: vi.fn(async (_viewer, _id, _runner, channelId) => channelId === parent.channelId ? parent : null) };
	const beforeInsert = vi.fn(async () => {});
	const create = { fetchAndCreate: vi.fn(async (_user, data) => { await beforeInsert(); await data.gridspaceReply.beforeInsert(manager); return { id: 'created' }; }) };
	const auth = { assertSource: vi.fn(), source: vi.fn(async () => actor) };
	const service = new GridspaceReplyService(db, { url: 'https://r.example' } as Config, links as unknown as GridspaceLinkService, reader as unknown as GridspacePrivateService,
		create as unknown as NoteCreateService, { getIdenticonUrl: () => '' } as unknown as UserEntityService, auth as unknown as GridspaceChannelAuthService);
	const input = { action: 'send', channelActorId: actor.id, channelId: destination.id, sourceChannelId: source.id, renoteId: parent.id, requestId: '00000000-0000-4000-8000-000000000001' } as ReplyPeerRequest;
	return { source, destination, parent, create, links, input, beforeInsert, send: () => service.peerReply(input, async () => {}) };
}

test('a G-only actor can renote to another R channel without an old-account grant', async () => {
	const f = fixture();
	await expect(f.send()).resolves.toMatchObject({ createdNoteId: 'created', account: { uri: 'https://g.example/users/guest' } });
	expect(f.create.fetchAndCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'guest' }), expect.objectContaining({ channelId: 'destination', renoteId: 'parent', localOnly: true }));
	expect(f.links.authorizePrivate).not.toHaveBeenCalled();
});

test.each(['export-disabled', 'wrong-source', 'private-source', 'invalid-reply'] as const)('rejects %s before creating a renote', async reason => {
	const f = fixture();
	if (reason === 'export-disabled') f.source.allowRenoteToExternal = false;
	if (reason === 'wrong-source') f.input.sourceChannelId = 'wrong';
	if (reason === 'private-source') f.parent.visibility = 'followers';
	if (reason === 'invalid-reply') { f.input.renoteId = undefined; f.input.noteId = f.parent.id; }
	await expect(f.send()).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
	expect(f.create.fetchAndCreate).not.toHaveBeenCalled();
});

test.each(['export-disabled', 'destination-archived'] as const)('rechecks %s immediately before insert', async reason => {
	const f = fixture();
	f.beforeInsert.mockImplementation(async () => { if (reason === 'export-disabled') f.source.allowRenoteToExternal = false; else f.destination.isArchived = true; });
	await expect(f.send()).rejects.toMatchObject({ code: 'REPLY_UNAVAILABLE' });
});

test('same-channel renote still works when exporting is disabled', async () => {
	const f = fixture(); f.source.allowRenoteToExternal = false; f.input.channelId = f.source.id; delete f.input.sourceChannelId;
	await expect(f.send()).resolves.toMatchObject({ createdNoteId: 'created' });
});
