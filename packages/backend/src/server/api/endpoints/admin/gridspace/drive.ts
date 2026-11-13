/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceSharedDriveService } from '@/core/gridspace/GridspaceSharedDriveService.js';
import { sharedDriveUnavailable } from '@/core/gridspace/shared-drive-protocol.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, secure: true,
	limit: { duration: 60000, max: 60 }, errors: { sharedDriveUnavailable },
	res: { type: 'object', optional: false, nullable: false, properties: {
		accounts: { type: 'integer', optional: false, nullable: false },
		preparing: { type: 'integer', optional: false, nullable: false },
		total: { type: 'integer', optional: false, nullable: false },
		pending: { type: 'integer', optional: false, nullable: false },
		failed: { type: 'integer', optional: false, nullable: false },
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	action: { type: 'string', enum: ['status', 'retry', 'release'], default: 'status' },
	userId: { type: 'string', format: 'misskey:id' },
}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceSharedDriveService) {
		super(meta, paramDef, async ps => {
			if (ps.action === 'retry') await service.retry();
			if (ps.action === 'release') {
				if (!ps.userId) throw new ApiError(sharedDriveUnavailable);
				await service.release(ps.userId);
			}
			return service.status(ps.userId);
		});
	}
}
