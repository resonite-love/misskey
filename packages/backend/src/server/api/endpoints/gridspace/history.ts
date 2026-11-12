/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceHistoryError, GridspaceHistoryService } from '@/core/gridspace/GridspaceHistoryService.js';

export const meta = {
	tags: ['users', 'notes'], requireCredential: false,
	limit: { duration: 60000, max: 60 },
	errors: { historyUnavailable: { message: 'Linked history is unavailable.', code: 'GRIDSPACE_HISTORY_UNAVAILABLE', id: '9f2e4ae6-715c-4e38-abc0-9f024f086825' } },
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			notes: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'Note' } },
			cursor: { type: 'string', optional: false, nullable: true },
		},
	},
} as const;

export const paramDef = {
	type: 'object', properties: {
		userId: { type: 'string', format: 'misskey:id', maxLength: 32 },
		cursor: { type: 'string', minLength: 1, maxLength: 2048 },
		limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
		withReplies: { type: 'boolean', default: true },
		withRenotes: { type: 'boolean', default: true },
		withFiles: { type: 'boolean', default: false },
		withChannelNotes: { type: 'boolean', default: true },
	}, required: ['userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private history: GridspaceHistoryService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				return await this.history.history(ps.userId, me, { withReplies: ps.withReplies, withRenotes: ps.withRenotes, withFiles: ps.withFiles, withChannelNotes: ps.withChannelNotes }, ps.limit, ps.cursor);
			} catch (error) {
				if (error instanceof GridspaceHistoryError) throw new ApiError(meta.errors.historyUnavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
