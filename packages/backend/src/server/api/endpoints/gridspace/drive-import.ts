/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceDriveService } from '@/core/gridspace/GridspaceDriveService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';

export const meta = {
	tags: ['drive'], requireCredential: true, secure: true, prohibitMoved: true, limit: { duration: 60000, max: 20 },
	errors: { unavailable: { message: 'The linked file could not be imported.', code: 'GRIDSPACE_DRIVE_IMPORT_FAILED', id: '247d84d8-3816-4227-b18a-a37a3b578b67' } },
	res: { type: 'object', optional: false, nullable: false, ref: 'DriveFile' },
} as const;
export const paramDef = { type: 'object', properties: { fileId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } }, required: ['fileId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private drive: GridspaceDriveService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.drive.importFile(me, ps.fileId); } catch (error) {
				if (error instanceof GridspaceLinkError || error instanceof IdentifiableError) throw new ApiError(meta.errors.unavailable, { reason: error instanceof GridspaceLinkError ? error.code : 'FILE_REJECTED' });
				throw error;
			}
		});
	}
}
