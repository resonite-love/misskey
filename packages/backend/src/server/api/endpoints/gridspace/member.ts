/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceHistoryService } from '@/core/gridspace/GridspaceHistoryService.js';

export const meta = {
	tags: ['users'], requireCredential: false,
	limit: { duration: 60000, max: 60 },
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			enabled: { type: 'boolean', optional: false, nullable: false },
			linked: { type: 'boolean', optional: false, nullable: false },
			available: { type: 'boolean', optional: false, nullable: false },
			accounts: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'UserLite' } },
		},
	},
} as const;

export const paramDef = {
	type: 'object', properties: { userId: { type: 'string', format: 'misskey:id', maxLength: 32 } }, required: ['userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private history: GridspaceHistoryService) {
		super(meta, paramDef, (ps, me) => this.history.member(ps.userId, me));
	}
}
