/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspacePlacementService } from '@/core/gridspace/GridspacePlacementService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { placementChannelOptions, placementChannelResult } from '@/core/gridspace/placement-protocol.js';

export const meta = {
	tags: ['channels'], requireCredential: true, secure: true,
	description: 'Returns supported channels on the paired server.',
	limit: { duration: 60_000, max: 60 },
	errors: { unavailable: { message: 'The channel placement is unavailable.', code: 'PLACEMENT_UNAVAILABLE', id: 'f2d33fee-cc84-462c-b7aa-de60cee4dac2' } },
	res: placementChannelResult,
} as const;

export const paramDef = {
	type: 'object', properties: placementChannelOptions, required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(placements: GridspacePlacementService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await placements.channels(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
