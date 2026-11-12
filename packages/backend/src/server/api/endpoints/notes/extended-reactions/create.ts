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
	description: 'Add a local or paired-community reaction. The first reaction uses ordinary federation.',
	tags: ['reactions', 'notes'],

	requireCredential: true,

	prohibitMoved: true,

	limit: { duration: 1000 * 60 * 60, max: 300 },

	kind: 'write:reactions',

	errors: {
		peerUnavailable: { message: 'The paired server is unavailable.', code: 'PEER_UNAVAILABLE', id: 'f74c07ab-020f-4b92-a534-a2bcbcf355fd' },
		localOnly: { message: 'Extended reactions require a local note.', code: 'LOCAL_ONLY', id: '65308466-0ece-40bc-8467-d85e9c3bcfad' },
		tooManyReactions: { message: 'At most 16 reactions per user and note.', code: 'TOO_MANY_REACTIONS', id: 'd1f80842-bc34-432e-8a69-a17e8311ed23' },
		notAccessible: { message: 'Note not accessible.', code: 'NO_SUCH_NOTE', id: 'd5e14013-71dc-4281-b1e0-8c9e3e82fa94' },
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'fb85b56e-6f8a-4045-9867-e25005f6b45c',
		},

		alreadyReacted: {
			message: 'You are already reacting to that note.',
			code: 'ALREADY_REACTED',
			id: '37f2e1d1-fbd0-4c66-8b3b-739a88501313',
		},

		youHaveBeenBlocked: {
			message: 'You cannot react this note because you have been blocked by this user.',
			code: 'YOU_HAVE_BEEN_BLOCKED',
			id: '0f4ce93a-8866-4e22-b027-397436caddf5',
		},

		cannotReactToRenote: {
			message: 'You cannot react to Renote.',
			code: 'CANNOT_REACT_TO_RENOTE',
			id: '02509bb4-1442-4c88-a21c-9ed343c778ef',
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
			await this.reactionService.create(me, note, ps.reaction).catch(err => {
				if (err.id === 'gridspace-reactions-unavailable') throw new ApiError(meta.errors.peerUnavailable);
				if (err.id === 'extended-local-only') throw new ApiError(meta.errors.localOnly);
				if (err.id === 'extended-reaction-limit') throw new ApiError(meta.errors.tooManyReactions);
				if (err.id === '68e9d2d1-48bf-42c2-b90a-b20e09fd3d48') throw new ApiError(meta.errors.notAccessible);
				if (err.id === '51c42bb4-931a-456b-bff7-e5a8a70dd298') throw new ApiError(meta.errors.alreadyReacted);
				if (err.id === 'e70412a4-7197-4726-8e74-f3e0deb92aa7') throw new ApiError(meta.errors.youHaveBeenBlocked);
				if (err.id === '12c35529-3c79-4327-b1cc-e2cf63a71925') throw new ApiError(meta.errors.cannotReactToRenote);
				throw err;
			});
			return;
		});
	}
}
