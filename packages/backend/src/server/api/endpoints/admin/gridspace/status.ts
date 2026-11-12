/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceAdminService } from '@/core/gridspace/GridspaceAdminService.js';
import { adminStatusSchema } from '@/core/gridspace/admin-protocol.js';

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, secure: true,
	limit: { duration: 60_000, max: 60 },
	res: adminStatusSchema,
} as const;

export const paramDef = { type: 'object', properties: {}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceAdminService) {
		super(meta, paramDef, async (ps, me) => service.status());
	}
}
