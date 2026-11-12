/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceReactionService } from '@/core/gridspace/GridspaceReactionService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { IdService } from '@/core/IdService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { ApiError } from '@/server/api/error.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';

export const meta = {
	description: 'List users of ordinary and extended reactions, including the paired community server.',
	tags: ['notes', 'reactions'],

	requireCredential: false,
	limit: { duration: 60000, max: 180 },

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'NoteReaction',
		},
	},

	errors: {
		peerUnavailable: { message: 'The paired server is unavailable.', code: 'PEER_UNAVAILABLE', id: 'cf213f4b-4dad-45a1-842f-3e8dd974c387' },
		invalidCursor: { message: 'Invalid reaction cursor.', code: 'INVALID_CURSOR', id: 'b50608c4-c0cf-431d-95db-79f5abb9a9c0' },
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'fee4db77-691c-43c1-8a00-62c76efab20a',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		type: { type: 'string', nullable: true, maxLength: 260 },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id', maxLength: 2048 },
		untilId: { type: 'string', format: 'misskey:id', maxLength: 2048 },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
	},
	required: ['noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private extendedReactionService: GridspaceReactionService,
		private noteEntityService: NoteEntityService,
		private idService: IdService,
		private getterService: GetterService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNoteWithRelations(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			if (!await this.noteEntityService.isVisibleForMe(note, me ? me.id : null)) {
				throw new ApiError(meta.errors.noSuchNote);
			}

			return this.extendedReactionService.list(note, me, ps.type, ps.limit, ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate) : undefined), ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate) : undefined)).catch(error => {
				if (error instanceof IdentifiableError && error.id === 'gridspace-reactions-unavailable') throw new ApiError(meta.errors.peerUnavailable);
				if (error instanceof IdentifiableError && error.id === 'gridspace-reactions-cursor') throw new ApiError(meta.errors.invalidCursor);
				throw error;
			});
		});
	}
}
