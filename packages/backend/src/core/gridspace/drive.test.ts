/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, test, expect } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiDriveFolder } from '@/models/DriveFolder.js';
import type { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import type { DownloadService } from '@/core/DownloadService.js';
import type { DriveService } from '@/core/DriveService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { GridspaceSharedDriveService } from './GridspaceSharedDriveService.js';
import { GridspaceDriveService } from './GridspaceDriveService.js';
import { GridspaceLinkError, type GridspaceLinkService } from './GridspaceLinkService.js';
import { validateDrivePage, type DrivePage } from './drive-protocol.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import type { DataSource } from 'typeorm';

const bytes = Buffer.from('owned drive file');
const file = { id: 'file1', name: 'owned.txt', url: 'https://r.example/files/owned.txt', thumbnailUrl: null, md5: createHash('md5').update(bytes).digest('hex'), size: bytes.length, type: 'text/plain', comment: 'caption', isSensitive: true };
const page = (): DrivePage => ({ enabled: true, granted: true, origin: 'https://r.example', files: [file as never], folders: [], path: [], filesNext: null, foldersNext: null });

function fixture(role: 'source' | 'client' = 'client') {
	const config = { url: role === 'client' ? 'https://g.example' : 'https://r.example', gridspace: { enabled: true, channelRole: role, peerUrl: 'https://r.example' }, maxFileSize: 1024 * 1024 } as Config;
	const db = mockDeep<DataSource>(); const links = mockDeep<GridspaceLinkService>();
	db.getRepository.mockReturnValue({ findOneBy: async () => null } as never);
	const files = mockDeep<DriveFileEntityService>(); const folders = mockDeep<DriveFolderEntityService>(); const downloads = mockDeep<DownloadService>();
	const drive = mockDeep<DriveService>(); const roles = mockDeep<RoleService>(); const guard = mockDeep<GridspaceFollowGuardService>();
	links.driveRequest.mockImplementation(async () => page() as never);
	links.driveActor.mockResolvedValue({ user: { id: 'owner' }, granted: true } as never);
	guard.run.mockImplementation(async (_id, work) => work());
	downloads.downloadUrl.mockImplementation(async (_url, path) => { await writeFile(path, bytes); return { filename: 'owned.txt' }; });
	roles.getUserPolicies.mockResolvedValue({ maxFileSizeMb: 1 } as never);
	drive.addFile.mockResolvedValue({ ...file, id: 'local', userId: 'viewer' } as never);
	files.pack.mockImplementation(async value => value as never);
	files.validateFileName.mockReturnValue(true);
	return { db, links, files, folders, downloads, drive, roles, guard, service: new GridspaceDriveService(config, db, links, files, folders, downloads, drive, roles, guard, mockDeep<GridspaceSharedDriveService>()), user: { id: 'viewer' } as MiLocalUser };
}

describe('linked drive', () => {
	test('imports verified bytes as a normal file owned by the current account', async () => {
		const f = fixture(); expect(await f.service.importFile(f.user, 'file1')).toMatchObject({ id: 'local', userId: 'viewer' });
		expect(f.downloads.downloadUrl.mock.invocationCallOrder[0]).toBeLessThan(f.guard.run.mock.invocationCallOrder[0]);
		expect(f.drive.addFile).toHaveBeenCalledWith(expect.objectContaining({ user: f.user, name: file.name, comment: file.comment, sensitive: true }));
		expect(f.links.driveRequest).toHaveBeenCalledTimes(2);
	});
	test('reuses an identical owned copy without hash-only metadata changes', async () => {
		const f = fixture();
		f.db.getRepository.mockReturnValue({ findOneBy: async (where: unknown) => { expect(where).toMatchObject({ userId: 'viewer', isLink: false, md5: file.md5, name: file.name, comment: file.comment, isSensitive: true }); return { ...file, id: 'reused' }; } } as never);
		expect(await f.service.importFile(f.user, 'file1')).toMatchObject({ id: 'reused' });
		expect(f.drive.addFile).not.toHaveBeenCalled();
	});
	test('preserves an extensionless source name after ordinary upload detection', async () => {
		const f = fixture(); f.links.driveRequest.mockImplementation(async () => ({ ...page(), files: [{ ...file, name: 'README' }] }) as never);
		f.drive.addFile.mockResolvedValue({ ...file, id: 'local', name: 'README.txt' } as never);
		f.drive.updateFile.mockResolvedValue({ ...file, id: 'local', name: 'README' } as never);
		expect(await f.service.importFile(f.user, 'file1')).toMatchObject({ name: 'README' });
		expect(f.drive.updateFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }), { name: 'README' }, f.user);
	});
	test('checks limits before downloading and rejects incorrect bytes', async () => {
		const f = fixture(); f.roles.getUserPolicies.mockResolvedValue({ maxFileSizeMb: 0 } as never);
		await expect(f.service.importFile(f.user, 'file1')).rejects.toThrow('FILE_REJECTED'); expect(f.downloads.downloadUrl).not.toHaveBeenCalled();
		f.roles.getUserPolicies.mockResolvedValue({ maxFileSizeMb: 1 } as never);
		f.downloads.downloadUrl.mockImplementation(async (_url, path) => { await writeFile(path, Buffer.alloc(bytes.length)); return { filename: 'bad' }; });
		await expect(f.service.importFile(f.user, 'file1')).rejects.toThrow('FILE_REJECTED'); expect(f.drive.addFile).not.toHaveBeenCalled();
	});
	test('revocation during download prevents copying into the destination', async () => {
		const f = fixture(); f.downloads.downloadUrl.mockImplementation(async (_url, path) => {
			await writeFile(path, bytes); f.links.driveRequest.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED')); return { filename: 'owned.txt' };
		});
		await expect(f.service.importFile(f.user, 'file1')).rejects.toThrow('AUTHORIZATION_REVOKED'); expect(f.drive.addFile).not.toHaveBeenCalled();
	});
	test('an existing link without the new grant exposes status but no content', async () => {
		const f = fixture('source'); f.links.driveActor.mockResolvedValue({ user: { id: 'owner' }, granted: false } as never);
		expect(await f.service.peer({ mode: 'status' })).toMatchObject({ granted: false, files: [], folders: [] });
		await expect(f.service.peer({ mode: 'list' })).rejects.toThrow('AUTHORIZATION_REVOKED');
		expect(f.db.getRepository).not.toHaveBeenCalled();
	});
	test('source file and folder resolution is scoped to the linked owner', async () => {
		const f = fixture('source'); const repository = { findOneBy: async (query: unknown) => { expect(query).toMatchObject({ userId: 'owner' }); return null; } };
		f.db.getRepository.mockImplementation(((entity: unknown) => { expect([MiDriveFile, MiDriveFolder]).toContain(entity); return repository; }) as DataSource['getRepository']);
		await expect(f.service.peer({ mode: 'file', fileId: 'other' })).rejects.toThrow('FILE_REJECTED');
		await expect(f.service.peer({ mode: 'list', folderId: 'other' })).rejects.toThrow('FILE_REJECTED');
	});
	test('rejects incorrect origins, credentials in URLs and unbounded pages', () => {
		expect(() => validateDrivePage(page(), 'https://g.example', 30)).toThrow();
		expect(() => validateDrivePage({ ...page(), files: [{ ...file, url: 'https://user:pass@r.example/a' }] as never }, 'https://r.example', 30)).toThrow();
		expect(() => validateDrivePage(page(), 'https://r.example', 0)).toThrow();
	});
});
