/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspacePlacementService } from '@/core/gridspace/GridspacePlacementService.js';
import { PlacementError } from '@/core/NotePlacementService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';

export const meta = {
	tags: ['channels'], requireCredential: true, secure: true, prohibitMoved: true,
	description: 'Removes one channel placement.',
	limit: { duration: 60_000, max: 30 },
	errors: { unavailable: { message: 'The channel placement is unavailable.', code: 'PLACEMENT_UNAVAILABLE', id: 'ec57b320-b408-45b0-8277-f2079835280d' } },
} as const;

export const paramDef = {
	type: 'object', properties: { canonicalUri: { type: 'string', maxLength: 512 }, channelOrigin: { type: 'string', maxLength: 512 }, channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } }, required: ['canonicalUri', 'channelOrigin', 'channelId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(placements: GridspacePlacementService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await placements.remove(me, ps); } catch (error) {
				if (error instanceof PlacementError) throw new ApiError(meta.errors.unavailable, { reason: error.message });
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
