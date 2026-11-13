/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceDriveService } from '@/core/gridspace/GridspaceDriveService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { driveOptionsSchema, drivePageSchema } from '@/core/gridspace/drive-protocol.js';

export const meta = {
	tags: ['drive'], requireCredential: true, secure: true, limit: { duration: 60000, max: 120 },
	errors: { unavailable: { message: 'The linked Drive is unavailable.', code: 'GRIDSPACE_DRIVE_UNAVAILABLE', id: '92f70f97-0fbc-42d0-afae-e42392659fa6' } },
	res: drivePageSchema,
} as const;
export const paramDef = { type: 'object', properties: driveOptionsSchema, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private drive: GridspaceDriveService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.drive.list(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
