/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceChannelService } from '@/core/gridspace/GridspaceChannelService.js';
import { channelOptionsSchema, channelResultSchema } from '@/core/gridspace/channel-protocol.js';

export const meta = {
	tags: ['channels'], requireCredential: true, kind: 'read:gridspace-private',
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked channels are unavailable.', code: 'GRIDSPACE_CHANNEL_UNAVAILABLE', id: 'bdc3e838-6b72-46f1-8c5a-f3dd18a140f3' } },
	res: channelResultSchema,
} as const;
export const paramDef = { type: 'object', properties: channelOptionsSchema, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private channels: GridspaceChannelService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			try {
				this.links.assertPrivateCaller(token);
				return await this.channels.list(me, ps);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
