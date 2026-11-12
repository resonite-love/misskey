/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceAdminService } from '@/core/gridspace/GridspaceAdminService.js';
import { adminJobSchema, adminJobKinds } from '@/core/gridspace/admin-protocol.js';

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, secure: true,
	limit: { duration: 60_000, max: 60 },
	res: { type: 'object', optional: false, nullable: false, properties: { items: { type: 'array', optional: false, nullable: false, items: adminJobSchema }, next: { type: 'string', optional: false, nullable: true } } },
} as const;

export const paramDef = { type: 'object', properties: { kind: { type: 'string', enum: adminJobKinds, default: 'import' }, after: { type: 'string', maxLength: 80 }, userId: { type: 'string', format: 'misskey:id' }, failedOnly: { type: 'boolean', default: true }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceAdminService) {
		super(meta, paramDef, async (ps, me) => service.jobs(ps));
	}
}
