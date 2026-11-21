/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspacePlacementActionService } from '@/core/gridspace/GridspacePlacementActionService.js';
import { conversationUriSchema } from '@/core/gridspace/conversation-protocol.js';
import { replyOptionsSchema } from '@/core/gridspace/reply-protocol.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['notes'], requireCredential: true, prohibitMoved: true, kind: 'write:gridspace-reply',
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'The reply could not be deleted.', code: 'GRIDSPACE_DELETE_REPLY_UNAVAILABLE', id: 'a7dd079f-6215-49cb-9bf6-951eb3d3c83a' } },
	res: { type: 'object', optional: false, nullable: false, properties: { deleted: { type: 'boolean', optional: false, nullable: false } } },
} as const;
export const paramDef = { type: 'object', properties: { canonicalUri: conversationUriSchema, requestId: replyOptionsSchema.requestId }, required: ['canonicalUri', 'requestId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private actions: GridspacePlacementActionService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			this.links.assertPrivateCaller(token);
			try { return await this.actions.deleteReply(me, ps.canonicalUri, ps.requestId); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
