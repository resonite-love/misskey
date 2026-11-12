/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceActionService } from '@/core/gridspace/GridspaceActionService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { uploadOptionsSchema, uploadResultSchema } from '@/core/gridspace/action-protocol.js';

export const meta = {
	tags: ['account'], requireCredential: true, secure: true, prohibitMoved: true, requireFile: true,
	limit: { duration: 60000, max: 20 },
	errors: { unavailable: { message: 'Linked account operation is unavailable.', code: 'GRIDSPACE_ACTION_UNAVAILABLE', id: '8b1ea7b7-8c25-4188-a4f7-550d96a0d349' } },
	res: uploadResultSchema,
} as const;
export const paramDef = { type: 'object', properties: uploadOptionsSchema, required: ['noteId', 'name'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private actions: GridspaceActionService) {
		super(meta, paramDef, async (ps, me, _token, file, cleanup) => {
			try { return await this.actions.upload(me, ps, file!.path); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			} finally { cleanup!(); }
		});
	}
}
