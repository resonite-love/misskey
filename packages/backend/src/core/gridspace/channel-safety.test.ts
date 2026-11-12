/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { DriveService } from '@/core/DriveService.js';

test.each(['deleteFile', 'deleteFileSync'] as const)('expiry via %s cannot delete an original without a remote URI', async method => {
	const storage = { del: vi.fn() };
	const service = Object.assign(Object.create(DriveService.prototype), { internalStorageService: storage }) as DriveService;
	Object.defineProperty(service, 'deletePostProcess', { value: vi.fn() });
	await service[method]({ uri: null, userHost: 'g.example', storedInternal: true, accessKey: 'original' } as MiDriveFile, true);
	expect(storage.del).not.toHaveBeenCalled();
	expect(service['deletePostProcess']).not.toHaveBeenCalled();
});

test('a revoked channel deletion rolls back before publishing deletion effects', async () => {
	const manager = mockDeep<EntityManager>();
	const db = mockDeep<DataSource>();
	const note = { id: 'note', userId: 'author', channelId: 'channel', localOnly: true } as MiNote;
	manager.findOne.mockResolvedValue(note);
	db.transaction.mockImplementation((async (action: (value: EntityManager) => unknown) => action(manager)) as never);
	const event = { publishNoteStream: vi.fn() };
	const service = Object.assign(Object.create(NoteDeleteService.prototype), { db, globalEventService: event }) as NoteDeleteService;
	const guard = vi.fn().mockRejectedValue(new Error('revoked'));
	await expect(service.delete({ id: 'author' } as MiUser, note, false, undefined, guard)).rejects.toThrow('revoked');
	expect(guard).toHaveBeenCalledWith(manager);
	expect(manager.delete).not.toHaveBeenCalled();
	expect(event.publishNoteStream).not.toHaveBeenCalled();
});
