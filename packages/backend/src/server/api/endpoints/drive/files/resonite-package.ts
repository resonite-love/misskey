/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import type { MiLocalUser } from '@/models/User.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { MiMeta } from '@/models/Meta.js';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GetterService } from '@/server/api/GetterService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { RoleService } from '@/core/RoleService.js';
import { ResonitePackageService } from '@/core/ResonitePackageService.js';
import { resonitePackageSchema } from '@/models/json-schema/resonite-package.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['drive'],
	requireCredential: false,
	limit: { duration: 60000, max: 20 },
	description: 'Read content statistics of an attached Resonite package.',
	res: { ...resonitePackageSchema, nullable: true },
	errors: {
		unavailable: { message: 'The attachment is not available.', code: 'NO_SUCH_FILE', id: '1e3807a4-0bfa-45ca-8a1d-4f9e67022446' },
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
		noteId: { type: 'string', format: 'misskey:id' },
	},
	required: ['fileId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository) private files: DriveFilesRepository,
		@Inject(DI.meta) private server: MiMeta,
		private getter: GetterService,
		private notes: NoteEntityService,
		private roles: RoleService,
		private packages: ResonitePackageService,
	) {
		super(meta, paramDef, async (ps, me, token) => {
			const file = await this.files.findOneBy({ id: ps.fileId });
			if (!file || !/\.resonitepackage$/i.test(file.name)) throw new ApiError(meta.errors.unavailable);
			const canReadDrive = token == null || token.permission.includes('read:drive');
			await this.authorize(file, ps.noteId, me, canReadDrive);
			let result;
			try {
				result = await this.packages.inspect(file);
			} catch {
				return null;
			}
			// Access may have changed while an older attachment was being read.
			await this.authorize(file, ps.noteId, me, canReadDrive);
			return result;
		});
	}

	private async authorize(file: MiDriveFile, noteId: string | undefined, me: MiLocalUser | null, canReadDrive: boolean): Promise<void> {
		if (canReadDrive && me && (file.userId === me.id || await this.roles.isModerator(me))) return;
		if (!noteId) throw new ApiError(meta.errors.unavailable);
		const note = await this.getter.getNoteWithRelations(noteId).catch(() => null);
		if (!note || (me == null && (note.user!.requireSigninToViewContents || this.server.ugcVisibilityForVisitor === 'none' ||
			(this.server.ugcVisibilityForVisitor === 'local' && note.userHost != null)))) throw new ApiError(meta.errors.unavailable);
		const packed = await this.notes.pack(note, me, { detail: true });
		if (packed.isHidden || !packed.files?.some(attachment => attachment.id === file.id)) throw new ApiError(meta.errors.unavailable);
	}
}
