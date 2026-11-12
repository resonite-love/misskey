/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GetterService } from '@/server/api/GetterService.js';
import { GridspaceReactionService } from '@/core/gridspace/GridspaceReactionService.js';
import { ApiError } from '../../../error.js';

export const meta = {
	description: 'Remove a local or paired-community reaction without promoting another reaction.',
	tags: ['reactions', 'notes'],

	requireCredential: true,

	kind: 'write:reactions',

	limit: {
		duration: 1000 * 60 * 60,
		max: 300,
	},

	errors: {
		peerUnavailable: { message: 'The paired server is unavailable.', code: 'PEER_UNAVAILABLE', id: '0d1b972c-674a-4800-9528-f148ea7ca8b1' },
		localOnly: { message: 'Extended reactions require a local note.', code: 'LOCAL_ONLY', id: 'acaa4d17-0e04-4178-9e70-0c6c70cd373b' },
		tooManyReactions: { message: 'At most 16 reactions per user and note.', code: 'TOO_MANY_REACTIONS', id: '158573c0-747d-46a8-87b6-1d27a6b05d9f' },
		notAccessible: { message: 'Note not accessible.', code: 'NO_SUCH_NOTE', id: 'be28b53a-f21f-4a6c-99dd-7757efdd7dfd' },
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: '833101aa-15f2-438a-9003-b1caadb32c3a',
		},

		notReacted: {
			message: 'You are not reacting to that note.',
			code: 'NOT_REACTED',
			id: 'fdc5af37-d516-4c44-b507-a80b931d3d9f',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		reaction: { type: 'string', minLength: 1, maxLength: 260 },
	},
	required: ['noteId', 'reaction'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private getterService: GetterService,
		private reactionService: GridspaceReactionService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNoteWithRelations(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});
			await this.reactionService.delete(me, note, ps.reaction).catch(err => {
				if (err.id === 'gridspace-reactions-unavailable') throw new ApiError(meta.errors.peerUnavailable);
				if (err.id === 'extended-local-only') throw new ApiError(meta.errors.localOnly);
				if (err.id === 'extended-reaction-limit') throw new ApiError(meta.errors.tooManyReactions);
				if (err.id === '68e9d2d1-48bf-42c2-b90a-b20e09fd3d48') throw new ApiError(meta.errors.notAccessible);
				if (err.id === '60527ec9-b4cb-4a88-a6bd-32d3ad26817d') throw new ApiError(meta.errors.notReacted);
				throw err;
			});
		});
	}
}
