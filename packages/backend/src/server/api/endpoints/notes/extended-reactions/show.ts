/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceReactionService } from '@/core/gridspace/GridspaceReactionService.js';

export const meta = {
	description: 'Get ordinary and extended reaction counts, including the paired community server.',
	tags: ['reactions', 'notes'],
	requireCredential: false,
	limit: { duration: 60000, max: 120 },
	res: {
		type: 'array', optional: false, nullable: false,
		items: {
			type: 'object', optional: false, nullable: false,
			properties: {
				shared: { type: 'boolean', optional: false, nullable: false },
				push: { type: 'boolean', optional: false, nullable: false },
				complete: { type: 'boolean', optional: false, nullable: false },
				revision: { type: 'string', optional: true, nullable: false },
				reactionVersions: { type: 'object', optional: true, nullable: false, additionalProperties: { type: 'string' } },
				noteId: { type: 'string', format: 'id', optional: false, nullable: false },
				reactions: { type: 'object', optional: false, nullable: false, additionalProperties: { type: 'number' } },
				reactionEmojis: { type: 'object', optional: false, nullable: false, additionalProperties: { type: 'string' } },
				myReaction: { type: 'string', optional: false, nullable: true },
				myReactions: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
			},
		},
	},
} as const;
export const paramDef = {
	type: 'object',
	properties: { noteIds: { type: 'array', items: { type: 'string', format: 'misskey:id' }, minItems: 1, maxItems: 100, uniqueItems: true } },
	required: ['noteIds'],
} as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private extendedReactionService: GridspaceReactionService) {
		super(meta, paramDef, async (ps, me) => this.extendedReactionService.show(ps.noteIds, me));
	}
}
