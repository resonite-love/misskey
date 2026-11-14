/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceChannelService } from '@/core/gridspace/GridspaceChannelService.js';
import { channelActionSchema, channelStateSchema } from '@/core/gridspace/channel-protocol.js';

export const meta = {
	tags: ['channels'], requireCredential: true, prohibitMoved: true, kind: 'write:gridspace-channel',
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked channel update is unavailable.', code: 'GRIDSPACE_CHANNEL_UPDATE_UNAVAILABLE', id: '55126735-b9bf-429c-8b4f-563b33f9a4e0' } },
	res: channelStateSchema,
} as const;
export const paramDef = { type: 'object', properties: {
	channelId: { type: 'string', format: 'misskey:id' }, action: channelActionSchema,
}, required: ['channelId', 'action'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private channels: GridspaceChannelService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			try {
				this.links.assertPrivateCaller(token);
				return await this.channels.update(me, ps);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
