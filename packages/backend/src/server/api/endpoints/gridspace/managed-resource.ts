/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceManagedResourceService } from '@/core/gridspace/GridspaceManagedResourceService.js';
import { managedError, managedInputProperties } from '@/core/gridspace/managed-resource-protocol.js';
const item = { type: 'object', additionalProperties: true } as const;
export const meta = {
	tags: ['account'], requireCredential: true, secure: true, kind: 'write:account', prohibitMoved: true,
	limit: { duration: 60000, max: 120 }, errors: { unavailable: managedError },
	res: { type: 'object', optional: false, nullable: false, properties: {
		enabled: { type: 'boolean', optional: false, nullable: false }, origin: { type: 'string', optional: false, nullable: true },
		item: { ...item, optional: false, nullable: true }, items: { type: 'array', optional: false, nullable: false, items: item },
		aliases: { type: 'array', optional: false, nullable: false, items: { type: 'object', properties: { sourceId: { type: 'string' }, targetId: { type: 'string' } } } },
		clipNoteError: { type: 'string', optional: true, nullable: false, enum: ['already-added', 'too-many'] },
	} },
} as const;
export const paramDef = { type: 'object', properties: managedInputProperties, required: ['kind', 'action'] } as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private resources: GridspaceManagedResourceService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.resources.request(me, ps); } catch (error) {
				if (error instanceof ApiError) throw error;
				throw new ApiError(managedError);
			}
		});
	}
}
