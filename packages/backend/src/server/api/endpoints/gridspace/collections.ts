/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';

const flag = { type: 'boolean', optional: false, nullable: false } as const;
export const meta = {
	tags: ['account', 'clips'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 120 },
	errors: { unavailable: { message: 'Linked collections are unavailable.', code: 'GRIDSPACE_COLLECTIONS_UNAVAILABLE', id: 'a36ea8b1-aa77-4a4e-8646-670539ef4938' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		enabled: flag, favorites: flag, clips: flag, clipFavorites: flag,
		scannedThrough: { type: 'string', optional: false, nullable: true },
		origin: { type: 'string', optional: false, nullable: true }, next: { type: 'string', optional: false, nullable: true },
		clipsList: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'Clip' } },
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	kind: { type: 'string', enum: ['status', 'clips', 'clip-favorites'], default: 'status' },
	clipId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, before: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } },
	limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private reader: GridspacePrivateService, private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me, token) => {
			try {
				this.links.assertPrivateCaller(token);
				return await this.reader.collections(me, ps.kind, ps.clipId, ps.before, ps.limit, ps.ids);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
