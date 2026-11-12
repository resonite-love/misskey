/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';

export const meta = {
	tags: ['notes'], requireCredential: true, kind: 'read:gridspace-private',
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'This private attachment is unavailable.', code: 'GRIDSPACE_PRIVATE_UNAVAILABLE', id: 'e5268930-bb04-4996-8f40-7f8f6589929a' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		data: { type: 'string', optional: false, nullable: false }, type: { type: 'string', optional: false, nullable: false },
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, fileId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
}, required: ['noteId', 'fileId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private reader: GridspacePrivateService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			try {
				this.links.assertPrivateCaller(token);
				return await this.reader.file(me, ps.noteId, ps.fileId);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
