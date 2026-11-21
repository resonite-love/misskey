/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspacePlacementService } from '@/core/gridspace/GridspacePlacementService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';

export const meta = {
	tags: ['channels'], requireCredential: true, secure: true, prohibitMoved: true,
	description: 'Retries outstanding deliveries for this actor\'s original note.',
	limit: { duration: 60_000, max: 30 },
	errors: { unavailable: { message: 'The channel placement is unavailable.', code: 'PLACEMENT_UNAVAILABLE', id: '5079f920-0f89-480e-af30-57fed14b53ad' } },
} as const;

export const paramDef = {
	type: 'object', properties: { canonicalUri: { type: 'string', maxLength: 512 } }, required: ['canonicalUri'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(placements: GridspacePlacementService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await placements.retry(me, ps.canonicalUri); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
