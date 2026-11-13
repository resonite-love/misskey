/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceContentService } from '@/core/gridspace/GridspaceContentService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { contentOptionsSchema, contentPageSchema } from '@/core/gridspace/content-protocol.js';

export const meta = {
	tags: ['pages', 'gallery'], requireCredential: false, limit: { duration: 60000, max: 120 },
	errors: { unavailable: { message: 'The linked public content is unavailable.', code: 'GRIDSPACE_CONTENT_UNAVAILABLE', id: '601831a9-216c-43aa-a968-19b435873cb4' } },
	res: contentPageSchema,
} as const;
export const paramDef = { type: 'object', properties: contentOptionsSchema, required: ['kind'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private content: GridspaceContentService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.content.list(ps, me != null, me?.id); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable);
				throw error;
			}
		});
	}
}
