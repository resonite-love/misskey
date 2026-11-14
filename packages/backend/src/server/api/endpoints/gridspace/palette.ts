/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';

const text = { type: 'string', optional: false, nullable: false } as const;
export const meta = {
	tags: ['account'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'Linked emoji palettes are unavailable.', code: 'GRIDSPACE_PALETTE_UNAVAILABLE', id: 'dcd7dd12-34a4-4c83-91ed-5cac8b6f07e4' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		peerOrigin: text, peerUserId: text,
		palette: { type: 'object', optional: false, nullable: true, properties: {
			version: { type: 'integer', optional: false, nullable: false },
			palettes: { type: 'array', optional: false, nullable: false, items: {
				type: 'object', optional: false, nullable: false, properties: {
					id: text, name: text, emojis: { type: 'array', optional: false, nullable: false, items: text },
				},
			} },
			forMain: { ...text, nullable: true }, forReaction: { ...text, nullable: true },
			recentlyUsedEmojis: { type: 'array', optional: true, nullable: false, maxItems: 32, items: text },
		} },
	} },
} as const;
export const paramDef = { type: 'object', properties: {}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private links: GridspaceLinkService) {
		super(meta, paramDef, async (_ps, me) => {
			try { return await this.links.palette(me); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
