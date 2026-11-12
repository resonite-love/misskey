/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceAdminService } from '@/core/gridspace/GridspaceAdminService.js';
import { adminLinkSchema } from '@/core/gridspace/admin-protocol.js';

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, secure: true,
	limit: { duration: 60_000, max: 60 },
	res: { type: 'object', optional: false, nullable: false, properties: { items: { type: 'array', optional: false, nullable: false, items: adminLinkSchema }, next: { type: 'string', optional: false, nullable: true } } },
} as const;

export const paramDef = { type: 'object', properties: { after: { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' }, userId: { type: 'string', format: 'misskey:id' }, issuesOnly: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceAdminService) {
		super(meta, paramDef, async (ps, me) => service.links(ps));
	}
}
