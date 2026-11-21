/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceEmojiSyncService } from '@/core/gridspace/GridspaceEmojiSyncService.js';

export const meta = {
	tags: ['meta'], requireCredential: false,
	limit: { duration: 60_000, max: 60 },
	res: { type: 'object', optional: false, nullable: false, properties: {
		aliases: { type: 'object', optional: false, nullable: false, additionalProperties: { type: 'string' } },
	} },
} as const;
export const paramDef = { type: 'object', properties: {}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceEmojiSyncService) {
		super(meta, paramDef, async () => ({ aliases: await service.reactionAliases() }));
	}
}
