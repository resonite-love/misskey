/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceReplyService } from '@/core/gridspace/GridspaceReplyService.js';
import { replyOptionsSchema, replyResultSchema } from '@/core/gridspace/reply-protocol.js';

export const meta = {
	tags: ['notes'], requireCredential: true, prohibitMoved: true, kind: 'write:gridspace-reply',
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'The delegated reply could not be completed.', code: 'GRIDSPACE_REPLY_UNAVAILABLE', id: 'ac627fc4-5283-48ec-bb42-c475432f7ea4' } },
	res: replyResultSchema,
} as const;
export const paramDef = { type: 'object', properties: replyOptionsSchema, anyOf: [{ required: ['noteId'] }, { required: ['renoteId'] }] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private replies: GridspaceReplyService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			try {
				this.links.assertPrivateCaller(token);
				return await this.replies.reply(me, ps);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
