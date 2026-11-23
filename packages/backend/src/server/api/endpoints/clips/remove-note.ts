/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ClipService } from '@/core/ClipService.js';
import { GridspaceClipReferenceService } from '@/core/gridspace/GridspaceClipReferenceService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['account', 'notes', 'clips'],

	requireCredential: true,

	prohibitMoved: true,

	kind: 'write:account',

	errors: {
		noSuchClip: {
			message: 'No such clip.',
			code: 'NO_SUCH_CLIP',
			id: 'b80525c6-97f7-49d7-a42d-ebccd49cfd52',
		},

		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'aff017de-190e-434b-893e-33a9ff5049d8',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		clipId: { type: 'string', format: 'misskey:id' },
		noteId: { type: 'string', format: 'misskey:id' },
		noteUri: { type: 'string', maxLength: 512 },
	},
	required: ['clipId', 'noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private clipService: ClipService,
		private clipReferences: GridspaceClipReferenceService,
	) {
		super(meta, paramDef, async (ps, me) => {
			try {
				if (ps.noteUri) {
					await this.clipReferences.change(me, ps.clipId, ps.noteUri, false, async () => {});
					return;
				}
				await this.clipService.removeNote(me, ps.clipId, ps.noteId);
			} catch (e) {
				if (e instanceof GridspaceLinkError) throw new ApiError(meta.errors.noSuchClip);
				if (e instanceof ClipService.NoSuchClipError) {
					throw new ApiError(meta.errors.noSuchClip);
				} else if (e instanceof ClipService.NoSuchNoteError) {
					throw new ApiError(meta.errors.noSuchNote);
				}
				throw e;
			}
		});
	}
}
