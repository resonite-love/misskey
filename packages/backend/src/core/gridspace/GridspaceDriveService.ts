/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiDriveFolder } from '@/models/DriveFolder.js';
import type { MiLocalUser } from '@/models/User.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import { DriveService } from '@/core/DriveService.js';
import { DownloadService } from '@/core/DownloadService.js';
import { RoleService } from '@/core/RoleService.js';
import { createTemp } from '@/misc/create-temp.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceSharedDriveService } from './GridspaceSharedDriveService.js';
import { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { validateDrivePage, type DriveOptions, type DrivePage, type DrivePeerRequest } from './drive-protocol.js';

@Injectable()
export class GridspaceDriveService {
	constructor(
		@Inject(DI.config) private config: Config, @Inject(DI.db) private db: DataSource,
		private links: GridspaceLinkService, private filePacker: DriveFileEntityService, private folderPacker: DriveFolderEntityService,
		private downloads: DownloadService, private drive: DriveService, private roles: RoleService, private guard: GridspaceFollowGuardService,
		private sharedDrive: GridspaceSharedDriveService,
	) {}

	private empty(enabled: boolean, origin: string | null): DrivePage {
		return { enabled, origin, granted: false, files: [], folders: [], path: [], filesNext: null, foldersNext: null };
	}

	public async peer(input: DrivePeerRequest): Promise<DrivePage> {
		const { user, granted } = await this.links.driveActor(input);
		const page = this.empty(true, new URL(this.config.url).origin);
		page.granted = granted;
		if (input.mode === 'status') return page;
		if (!granted) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const files = this.db.getRepository(MiDriveFile), folders = this.db.getRepository(MiDriveFolder);
		if (input.mode === 'file') {
			if (!input.fileId) throw new GridspaceLinkError('FILE_REJECTED');
			const file = await files.findOneBy({ id: input.fileId, userId: user.id, userHost: IsNull() });
			if (!file) throw new GridspaceLinkError('FILE_REJECTED');
			page.files = [await this.filePacker.pack(file, { self: true })];
		} else {
			let parentId = input.folderId;
			const seen = new Set<string>();
			while (parentId) {
				if (seen.has(parentId) || seen.size >= 64) throw new GridspaceLinkError('FILE_REJECTED');
				seen.add(parentId);
				const folder = await folders.findOneBy({ id: parentId, userId: user.id });
				if (!folder) throw new GridspaceLinkError('FILE_REJECTED');
				page.path.unshift(await this.folderPacker.pack(folder));
				parentId = folder.parentId;
			}
			const limit = input.limit ?? 30;
			const fileQuery = files.createQueryBuilder('file').where('file.userId = :userId AND file.userHost IS NULL', { userId: user.id });
			const folderQuery = folders.createQueryBuilder('folder').where('folder.userId = :userId', { userId: user.id });
			if (input.folderId) {
				fileQuery.andWhere('file.folderId = :folderId', { folderId: input.folderId });
				folderQuery.andWhere('folder.parentId = :folderId', { folderId: input.folderId });
			} else { fileQuery.andWhere('file.folderId IS NULL'); folderQuery.andWhere('folder.parentId IS NULL'); }
			if (input.filesBefore) fileQuery.andWhere('file.id < :before', { before: input.filesBefore });
			if (input.foldersBefore) folderQuery.andWhere('folder.id < :before', { before: input.foldersBefore });
			if (input.type?.endsWith('/*')) fileQuery.andWhere('file.type LIKE :type', { type: input.type.slice(0, -1).replace(/[\\%_]/g, '\\$&') + '%' });
			else if (input.type) fileQuery.andWhere('file.type = :type', { type: input.type });
			const [fileRows, folderRows] = await Promise.all([fileQuery.orderBy('file.id', 'DESC').take(limit + 1).getMany(), folderQuery.orderBy('folder.id', 'DESC').take(limit + 1).getMany()]);
			page.files = await this.filePacker.packMany(fileRows.slice(0, limit), { self: true });
			page.folders = await this.folderPacker.packMany(folderRows.slice(0, limit));
			page.filesNext = fileRows.length > limit ? page.files.at(-1)!.id : null;
			page.foldersNext = folderRows.length > limit ? page.folders.at(-1)!.id : null;
		}
		if (!(await this.links.driveActor(input)).granted) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return page;
	}

	public async list(user: MiLocalUser, input: DriveOptions): Promise<DrivePage> {
		if (input.mode === 'status' && (await this.links.privateLink(user.id).catch(() => null))?.driveShared) return this.empty(false, null);
		const origin = this.config.gridspace?.peerUrl ? new URL(this.config.gridspace.peerUrl).origin : null;
		const enabled = this.config.gridspace?.enabled === true && this.config.gridspace?.channelRole === 'client';
		if (!enabled) {
			if (input.mode !== 'status') throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return this.empty(false, origin);
		}
		try {
			const page = await this.links.driveRequest<DrivePage>(user, input);
			return validateDrivePage(page, origin!, input.mode === 'file' ? 1 : input.limit ?? 30);
		} catch (error) {
			if (input.mode === 'status' && error instanceof GridspaceLinkError && ['LINK_REVOKED', 'AUTHORIZATION_REVOKED'].includes(error.code)) return this.empty(true, origin);
			throw error;
		}
	}

	public async importFile(user: MiLocalUser, fileId: string) {
		const reference = await this.sharedDrive.referenceFile(user, fileId);
		if (reference) return reference;
		const source = (await this.list(user, { mode: 'file', fileId })).files[0];
		if (!source) throw new GridspaceLinkError('FILE_REJECTED');
		if (!this.filePacker.validateFileName(source.name)) throw new GridspaceLinkError('FILE_REJECTED');
		const policies = await this.roles.getUserPolicies(user.id);
		if (source.size > Math.min(this.config.maxFileSize, policies.maxFileSizeMb * 1024 * 1024)) throw new GridspaceLinkError('FILE_REJECTED');
		const [path, cleanup] = await createTemp();
		try {
			// Network I/O must not occupy the lock pool shared with following/revocation.
			// Only the final grant check and ordinary upload are serialized.
			try { await this.downloads.downloadUrl(source.url, path); } catch { throw new GridspaceLinkError('FILE_REJECTED'); }
			if ((await stat(path)).size !== source.size) throw new GridspaceLinkError('FILE_REJECTED');
			const hash = createHash('md5');
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			if (hash.digest('hex') !== source.md5) throw new GridspaceLinkError('FILE_REJECTED');
			return await this.guard.run(user.id, async () => {
				const fresh = (await this.list(user, { mode: 'file', fileId })).files[0];
				if (!fresh || fresh.md5 !== source.md5 || fresh.size !== source.size) throw new GridspaceLinkError('FILE_REJECTED');
				// Reuse only an identical local copy. Hash-only deduplication would lose
				// distinct names/captions or alter an existing file's sensitive flag.
				const existing = await this.db.getRepository(MiDriveFile).findOneBy({ userId: user.id, isLink: false, md5: fresh.md5, name: fresh.name,
					comment: fresh.comment === null ? IsNull() : fresh.comment, ...(fresh.isSensitive ? { isSensitive: true } : {}) });
				if (existing) return this.filePacker.pack(existing, { self: true });
				const file = await this.drive.addFile({ user, path, name: fresh.name, comment: fresh.comment, sensitive: fresh.isSensitive, force: true });
				// Upload detects an extension; preserve a valid name intentionally changed
				// in the source Drive (including extensionless names) after detection.
				if (file.name !== fresh.name) return this.drive.updateFile(file, { name: fresh.name }, user);
				return this.filePacker.pack(file, { self: true });
			});
		} finally { cleanup(); }
	}
}
