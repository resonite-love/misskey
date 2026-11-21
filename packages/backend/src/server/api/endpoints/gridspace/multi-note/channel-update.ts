/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspacePlacementService } from '@/core/gridspace/GridspacePlacementService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { channelActionSchema, channelOptionsSchema, channelStateSchema } from '@/core/gridspace/channel-protocol.js';

export const meta = {
	tags: ['channels'], requireCredential: true, secure: true, prohibitMoved: true,
	description: 'Updates this actor\'s channel following or favorite.',
	limit: { duration: 60_000, max: 30 },
	errors: { unavailable: { message: 'The channel placement is unavailable.', code: 'PLACEMENT_UNAVAILABLE', id: 'c512b970-0e04-47ae-a80a-c2847b61f6ec' } },
	res: channelStateSchema,
} as const;

export const paramDef = {
	type: 'object', properties: { channelId: channelOptionsSchema.channelId, action: channelActionSchema }, required: ['channelId', 'action'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(placements: GridspacePlacementService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await placements.updateChannel(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
