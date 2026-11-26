/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { inspectResonitePackage } from '@/misc/resonite-package.js';
import type { ResonitePackageInfo } from '@/misc/resonite-package.js';
import { createTemp } from '@/misc/create-temp.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { DownloadService } from '@/core/DownloadService.js';

@Injectable()
export class ResonitePackageService {
	private pending = new Map<string, Promise<ResonitePackageInfo | null>>();

	constructor(
		@Inject(DI.driveFilesRepository) private files: DriveFilesRepository,
		private storage: InternalStorageService,
		private downloads: DownloadService,
	) {}

	public async inspect(file: MiDriveFile): Promise<ResonitePackageInfo | null> {
		if (file.properties.resonitePackage?.schemaVersion === 1) return file.properties.resonitePackage;
		if (this.pending.has(file.id)) return this.pending.get(file.id)!;
		if (!/\.resonitepackage$/i.test(file.name) || file.size > 512 * 1024 * 1024 || this.pending.size >= 2) return null;
		const result = this.read(file);
		this.pending.set(file.id, result);
		try {
			return await result;
		} finally {
			this.pending.delete(file.id);
		}
	}

	private async read(file: MiDriveFile): Promise<ResonitePackageInfo | null> {
		let path: string;
		let cleanup: (() => void) | undefined;
		try {
			if (file.storedInternal && file.accessKey) {
				path = this.storage.resolvePath(file.accessKey);
			} else {
				if (!/^https?:\/\//i.test(file.url)) return null;
				[path, cleanup] = await createTemp();
				await this.downloads.downloadUrl(file.url, path, { maxSize: 512 * 1024 * 1024 });
			}
			const info = await inspectResonitePackage(path);
			if (info == null) return null;
			// Preserve concurrent edits to other DriveFile properties.
			await this.files.createQueryBuilder().update().set({ properties: () => 'jsonb_set(COALESCE(properties, \'{}\'::jsonb), \'{resonitePackage}\', CAST(:packageInfo AS jsonb), true)' })
				.where('id = :id', { id: file.id }).setParameter('packageInfo', JSON.stringify(info)).execute();
			return info;
		} finally {
			cleanup?.();
		}
	}
}
