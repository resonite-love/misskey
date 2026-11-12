/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceSearchError, GridspaceSearchService } from '@/core/gridspace/GridspaceSearchService.js';

export const meta = {
	tags: ['users', 'notes'], requireCredential: false,
	limit: { duration: 60000, max: 30 },
	errors: { searchUnavailable: { message: 'Community search is unavailable.', code: 'GRIDSPACE_SEARCH_UNAVAILABLE', id: '19566bb0-2bd2-4a5f-81d8-25f07cb6bf02' } },
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			notes: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'Note' } },
			users: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
				user: { type: 'object', optional: false, nullable: false, ref: 'UserLite' },
				linkedAccounts: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'UserLite' } },
			} } },
			peerAvailable: { type: 'boolean', optional: false, nullable: false },
			cursor: { type: 'string', optional: false, nullable: true },
		},
	},
} as const;

export const paramDef = {
	type: 'object', properties: {
		kind: { type: 'string', enum: ['notes', 'users'], default: 'notes' },
		query: { type: 'string', minLength: 1, maxLength: 200 },
		userId: { type: 'string', format: 'misskey:id', maxLength: 32 },
		rangeStartAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
		rangeEndAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
		cursor: { type: 'string', minLength: 1, maxLength: 4096 },
		limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
	}, required: ['query'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private search: GridspaceSearchService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				return await this.search.search(ps.kind, { query: ps.query, userId: ps.userId, rangeStartAt: ps.rangeStartAt, rangeEndAt: ps.rangeEndAt }, me, ps.limit, ps.cursor);
			} catch (error) {
				if (error instanceof GridspaceSearchError) throw new ApiError(meta.errors.searchUnavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
