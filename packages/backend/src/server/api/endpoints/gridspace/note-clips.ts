/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceNoteClipsService } from '@/core/gridspace/GridspaceNoteClipsService.js';

export const meta = {
	tags: ['notes', 'clips'], requireCredential: false,
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'The note clips are unavailable.', code: 'NOTE_CLIPS_UNAVAILABLE', id: 'aa96c64a-437a-41d6-8a8c-6c2d0cf9f902' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		clips: { type: 'array', optional: false, nullable: false, items: { type: 'object', ref: 'Clip', optional: false, nullable: false } },
		partial: { type: 'boolean', optional: false, nullable: false },
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	noteId: { type: 'string', format: 'misskey:id' },
	source: { type: 'string', enum: ['local', 'peer'], default: 'local' },
	channelId: { type: 'string', format: 'misskey:id' },
}, required: ['noteId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private clips: GridspaceNoteClipsService) {
		super(meta, paramDef, async (ps, me, token) => {
			try {
				return await this.clips.list(ps, me, token);
			} catch { throw new ApiError(meta.errors.unavailable); }
		});
	}
}
