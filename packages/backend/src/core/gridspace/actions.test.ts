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
import type { PollService } from '@/core/PollService.js';
import type { DriveService } from '@/core/DriveService.js';
import type { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GridspaceActionService } from './GridspaceActionService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { ActionOptions } from './action-protocol.js';

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
	links.privateCredential.mockReturnValue({ accessToken: 'peer-secret', linkId: 'link' });
	links.hasActionScope.mockResolvedValue(true); links.hasReplyScope.mockResolvedValue(true);
	reader.readableSourceNote.mockResolvedValue({ id: 'note', channelId: null } as MiNote);
	reader.notes.mockResolvedValue({ notes: [{ id: 'note' }] } as never);
	files.validateFileName.mockReturnValue(true);
	const service = new GridspaceActionService(db, { url: 'https://r.example', maxFileSize: 1024 } as Config, links, reader,
		mockDeep<ReactionService>(), mockDeep<PollService>(), drive, files, mockDeep<UserEntityService>());
	return { service, db, links, reader, drive, user };
}

describe('delegated actions', () => {
	test('forwards only action parameters and uses server-held credentials', async () => {
		const f = fixture();
		await f.service.action(f.user, { action: 'react', noteId: 'note', reaction: '👍', i: 'session-secret', accessToken: 'attacker', localUserId: 'other' } as ActionOptions);
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/private/action', { action: 'react', noteId: 'note', reaction: '👍', choice: undefined, accessToken: 'peer-secret', linkId: 'link' });
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
