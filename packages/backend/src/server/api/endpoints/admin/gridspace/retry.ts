/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceAdminService } from '@/core/gridspace/GridspaceAdminService.js';
import { adminJobKinds } from '@/core/gridspace/admin-protocol.js';

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, secure: true,
	limit: { duration: 60_000, max: 60 },
	res: { type: 'object', optional: false, nullable: false, properties: { retried: { type: 'boolean', optional: false, nullable: false } } },
} as const;

export const paramDef = { type: 'object', properties: { kind: { type: 'string', enum: adminJobKinds }, id: { type: 'string', minLength: 1, maxLength: 80 }, generation: { type: 'integer', minimum: 1 }, version: { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' } }, required: ['kind', 'id'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceAdminService) {
		super(meta, paramDef, async (ps, me) => ({ retried: await service.retry(me, ps) }));
	}
}
