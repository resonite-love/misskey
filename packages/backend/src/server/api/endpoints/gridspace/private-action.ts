/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceActionService } from '@/core/gridspace/GridspaceActionService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { actionOptionsSchema, actionResultSchema } from '@/core/gridspace/action-protocol.js';

export const meta = {
	tags: ['account'], requireCredential: true, secure: true, prohibitMoved: true,
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked account operation is unavailable.', code: 'GRIDSPACE_ACTION_UNAVAILABLE', id: 'a3520246-54ca-482f-a9c6-abb4ceefb626' } },
	res: actionResultSchema,
} as const;
export const paramDef = { type: 'object', properties: actionOptionsSchema, required: ['noteId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private actions: GridspaceActionService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.actions.action(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
