/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';
import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';

export const driveOptionsSchema = {
	mode: { type: 'string', enum: ['status', 'list', 'file'], default: 'status' },
	folderId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$', nullable: true },
	fileId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	filesBefore: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	foldersBefore: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
	type: { type: 'string', maxLength: 128 },
} as const;
export type DriveOptions = { mode: 'status' | 'list' | 'file'; folderId?: string | null; fileId?: string; filesBefore?: string; foldersBefore?: string; limit?: number; type?: string };
export type DrivePeerRequest = GridspacePeerLinkRequest & DriveOptions;
export type DrivePage = { enabled: boolean; granted: boolean; origin: string | null; files: Packed<'DriveFile'>[]; folders: Packed<'DriveFolder'>[]; path: Packed<'DriveFolder'>[]; filesNext: string | null; foldersNext: string | null };

export const drivePageSchema = {
	type: 'object', optional: false, nullable: false, properties: {
		enabled: { type: 'boolean', optional: false, nullable: false }, granted: { type: 'boolean', optional: false, nullable: false },
		origin: { type: 'string', optional: false, nullable: true },
		files: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'DriveFile' } },
		folders: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'DriveFolder' } },
		path: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'DriveFolder' } },
		filesNext: { type: 'string', optional: false, nullable: true }, foldersNext: { type: 'string', optional: false, nullable: true },
	},
} as const;

export function validateDrivePage(page: DrivePage, origin: string, limit: number): DrivePage {
	if (!page || page.enabled !== true || page.origin !== origin || typeof page.granted !== 'boolean' || !Array.isArray(page.files) || page.files.length > limit ||
		!Array.isArray(page.folders) || page.folders.length > limit || !Array.isArray(page.path) || page.path.length > 64) throw new Error('Invalid drive page');
	if (!page.granted && (page.files.length || page.folders.length || page.path.length)) throw new Error('Unauthorized drive data');
	const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(id);
	const validUrl = (value: string) => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; };
	if (page.files.some(file => !validId(file.id) || !/^[a-f0-9]{32}$/i.test(file.md5) || !Number.isSafeInteger(file.size) || file.size < 0 || !validUrl(file.url) || (file.thumbnailUrl != null && !validUrl(file.thumbnailUrl)))) throw new Error('Invalid drive file');
	if ([...page.folders, ...page.path].some(folder => !validId(folder.id))) throw new Error('Invalid drive folder');
	if ([page.filesNext, page.foldersNext].some(id => id !== null && !validId(id))) throw new Error('Invalid drive cursor');
	return page;
}
