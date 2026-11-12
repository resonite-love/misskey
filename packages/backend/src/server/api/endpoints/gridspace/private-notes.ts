/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';
import { privateNoteSchema, privateOptionsSchema } from '@/core/gridspace/private-protocol.js';

export const meta = {
	tags: ['notes'], requireCredential: true, kind: 'read:gridspace-private',
	limit: { duration: 60000, max: 120 },
	errors: { unavailable: { message: 'Private notes are unavailable.', code: 'GRIDSPACE_PRIVATE_UNAVAILABLE', id: '591c82a9-e0a5-4402-8598-28d3bc7c78f4' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		notes: { type: 'array', optional: false, nullable: false, items: privateNoteSchema },
		cursor: { type: 'string', optional: false, nullable: true },
	} },
} as const;
export const paramDef = {
	type: 'object', properties: { ...privateOptionsSchema,
		limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }, cursor: { type: 'string', minLength: 1, maxLength: 4096 },
	}, required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private reader: GridspacePrivateService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			const { cursor, limit, ...options } = ps;
			try {
				this.links.assertPrivateCaller(token);
				return await this.reader.notes(me, options, limit, cursor);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
