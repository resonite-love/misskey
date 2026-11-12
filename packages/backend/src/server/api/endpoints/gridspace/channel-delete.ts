/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceChannelService } from '@/core/gridspace/GridspaceChannelService.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';

export const meta = {
	tags: ['channels'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'The channel note could not be deleted.', code: 'GRIDSPACE_CHANNEL_DELETE_UNAVAILABLE', id: 'b75f6f01-efb0-4ee3-b856-aa37d4303425' } },
	res: { type: 'object', optional: false, nullable: false, properties: { deleted: { type: 'boolean', optional: false, nullable: false } } },
} as const;
export const paramDef = { type: 'object', properties: {
	noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, asCurrentAccount: { type: 'boolean', default: false },
}, required: ['noteId', 'channelId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private channels: GridspaceChannelService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			try { this.links.assertPrivateCaller(token); return await this.channels.delete(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
