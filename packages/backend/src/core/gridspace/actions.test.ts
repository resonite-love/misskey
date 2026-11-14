/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiGridspaceLink } from '@/models/Gridspace.js';
import type { ReactionService } from '@/core/ReactionService.js';
import type { ExtendedReactionService } from '@/core/ExtendedReactionService.js';
import type { PollService } from '@/core/PollService.js';
import type { DriveService } from '@/core/DriveService.js';
import type { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GridspaceActionService } from './GridspaceActionService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceReactionService } from './GridspaceReactionService.js';
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import type { ActionOptions } from './action-protocol.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';

function fixture() {
	const db = mockDeep<DataSource>();
	const links = mockDeep<GridspaceLinkService>();
	const reader = mockDeep<GridspacePrivateService>();
	const drive = mockDeep<DriveService>();
	const files = mockDeep<DriveFileEntityService>();
	const user = { id: 'old', host: null } as MiLocalUser;
	db.getRepository.mockReturnValue({ findOneBy: async () => user } as never);
	db.transaction.mockImplementation((async (callback: (manager: unknown) => unknown) => callback(db.manager)) as never);
	links.authorizePrivate.mockResolvedValue({ localUserId: user.id } as MiGridspaceLink);
	links.privateLink.mockResolvedValue({ id: 'link' } as MiGridspaceLink);
	links.json.mockResolvedValue({ note: { id: 'note' } });
	links.privateCredential.mockReturnValue({ accessToken: 'peer-secret', linkId: 'link' });
	links.hasActionScope.mockResolvedValue(true); links.hasReplyScope.mockResolvedValue(true);
	reader.readableSourceNote.mockResolvedValue({ id: 'note', channelId: null, userHost: null } as MiNote);
	reader.notes.mockResolvedValue({ notes: [{ id: 'note' }] } as never);
	reader.peerNotes.mockResolvedValue({ notes: [{ id: 'note' }] } as never);
	reader.filterChannelRenote.mockImplementation((...args) => GridspacePrivateService.prototype.filterChannelRenote.call(reader, ...args));
	files.validateFileName.mockReturnValue(true);
	const reactions = mockDeep<ReactionService>();
	reactions.withReactionLock.mockImplementation(async (_userId, _noteId, work) => work());
	const extended = mockDeep<ExtendedReactionService>();
	const paired = mockDeep<GridspaceReactionService>();
	paired.prepareMutation.mockImplementation(async (_user, note) => note);
	const service = new GridspaceActionService(db, { url: 'https://r.example', maxFileSize: 1024 } as Config, links, reader,
		reactions, mockDeep<PollService>(), drive, files, mockDeep<UserEntityService>(), extended, paired, mockDeep<GridspaceChannelAuthService>());
	return { service, db, links, reader, drive, user, reactions, extended };
}

describe('delegated actions', () => {
	test.each([true, false])('action responses apply the same embedded-source filter as ordinary reads (%s)', async readable => {
		const f = fixture();
		f.links.json.mockResolvedValue({ note: { id: 'note', renote: { id: 'original', text: 'Original content', filterActors: [], renote: { text: 'deeper' } } } });
		f.reader.localAllows.mockResolvedValue(readable);
		const result = await f.service.action(f.user, { action: 'react', noteId: 'note', reaction: '👍' });
		if (readable) { expect(result.note.renote).toEqual({ id: 'original', text: 'Original content' }); } else expect(result.note).not.toHaveProperty('renote');
		expect(f.reader.localAllows).toHaveBeenCalledOnce();
	});
	test('channel extra reactions use the old local identity and require channel permission', async () => {
		const f = fixture();
		const input = { action: 'remove-reaction' as const, noteId: 'note', channelId: 'channel', reaction: '🎉' };
		f.reader.readableSourceNote.mockResolvedValue({ id: 'note', channelId: 'channel', userHost: null } as MiNote);
		f.links.hasChannelScope.mockResolvedValue(false);
		await expect(f.service.peerAction(input, async () => {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.extended.deleteUnlocked).not.toHaveBeenCalled();
		f.links.hasChannelScope.mockResolvedValue(true);
		await f.service.peerAction(input, async () => {});
		expect(f.extended.deleteUnlocked).toHaveBeenCalledWith(f.user, expect.objectContaining({ channelId: 'channel' }), '🎉', false, false);
		f.links.authorizePrivate.mockResolvedValue({ localUserId: f.user.id, initiator: true } as MiGridspaceLink);
		await expect(f.service.peerAction(input, async () => {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.extended.deleteUnlocked).toHaveBeenCalledTimes(1);
	});
	test.each(['add-reaction', 'remove-reaction'] as const)('%s requires explicit scope and source visibility under the lock', async action => {
		const f = fixture(); const input = { action, noteId: 'note', reaction: '👍' };
		f.links.hasActionScope.mockResolvedValue(false);
		await expect(f.service.peerAction(input, async () => {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.extended.createUnlocked).not.toHaveBeenCalled(); expect(f.extended.deleteUnlocked).not.toHaveBeenCalled();
		f.links.hasActionScope.mockResolvedValue(true);
		f.reader.readableSourceNote.mockResolvedValueOnce({ id: 'note', channelId: null, userHost: null } as MiNote).mockResolvedValue(null);
		await expect(f.service.peerAction(input, async () => {})).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		expect(f.links.lockReplyAuthorization).toHaveBeenCalled();
		expect(f.extended.createUnlocked).not.toHaveBeenCalled(); expect(f.extended.deleteUnlocked).not.toHaveBeenCalled();
	});
	test('retries membership operations without toggling, preserving the source identity', async () => {
		const f = fixture();
		f.extended.createUnlocked.mockRejectedValue(new IdentifiableError('51c42bb4-931a-456b-bff7-e5a8a70dd298'));
		await f.service.peerAction({ action: 'add-reaction', noteId: 'note', reaction: '👍' }, async () => {});
		expect(f.extended.createUnlocked).toHaveBeenCalledWith(f.user, expect.objectContaining({ id: 'note' }), '👍', false, false);
		f.extended.deleteUnlocked.mockRejectedValue(new IdentifiableError('60527ec9-b4cb-4a88-a6bd-32d3ad26817d'));
		await f.service.peerAction({ action: 'remove-reaction', noteId: 'note', reaction: '👍' }, async () => {});
		expect(f.extended.deleteUnlocked).toHaveBeenCalledWith(f.user, expect.objectContaining({ id: 'note' }), '👍', false, false);
		f.extended.createUnlocked.mockRejectedValue(new IdentifiableError('extended-reaction-limit'));
		await expect(f.service.peerAction({ action: 'add-reaction', noteId: 'note', reaction: '👍' }, async () => {})).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
	});
	test('forwards only action parameters and uses server-held credentials', async () => {
		const f = fixture();
		await f.service.action(f.user, { action: 'react', noteId: 'note', reaction: '👍', i: 'session-secret', accessToken: 'attacker', localUserId: 'other' } as ActionOptions);
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/private/action', { action: 'react', noteId: 'note', channelId: undefined, reaction: '👍', choice: undefined, untilId: undefined, limit: undefined, accessToken: 'peer-secret', linkId: 'link' });
		expect(f.links.checkPrivateUnchanged).toHaveBeenCalled();
	});
	test('does not send an operation when the destination blocks the note', async () => {
		const f = fixture(); f.reader.notes.mockResolvedValue({ notes: [] } as never);
		await expect(f.service.action(f.user, { action: 'react', noteId: 'note', reaction: '👍' })).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		expect(f.links.json).not.toHaveBeenCalled();
	});
	test('requires explicit write consent and honors the source upload cap', async () => {
		const f = fixture(); f.links.hasActionScope.mockResolvedValue(false);
		await expect(f.service.peerUpload({ noteId: 'note', name: 'x', data: 'eA==' }, async () => {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		f.links.hasActionScope.mockResolvedValue(true);
		await expect(f.service.peerUpload({ noteId: 'note', name: 'x', data: Buffer.alloc(1025).toString('base64') }, async () => {})).rejects.toMatchObject({ code: 'FILE_REJECTED' });
		expect(f.drive.addFile).not.toHaveBeenCalled();
	});
	test('removes only its new upload if readability disappears during processing', async () => {
		const f = fixture(); const file = { id: 'newfile' } as MiDriveFile;
		f.drive.addFile.mockImplementation(async () => { f.reader.readableSourceNote.mockResolvedValue(null); return file; });
		await expect(f.service.peerUpload({ noteId: 'note', name: 'x', data: 'eA==' }, async () => {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.links.lockReplyAuthorization).toHaveBeenCalled();
		expect(f.drive.addFile).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
		expect(f.drive.deleteFileSync).toHaveBeenCalledWith(file);
	});
});
