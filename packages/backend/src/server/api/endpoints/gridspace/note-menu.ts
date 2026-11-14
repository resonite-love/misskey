/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceNoteMenuService } from '@/core/gridspace/GridspaceNoteMenuService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { noteMenuProperties, noteMenuResultSchema } from '@/core/gridspace/note-menu-protocol.js';

export const meta = {
	tags: ['account'], requireCredential: true, secure: true, prohibitMoved: true,
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked account operation is unavailable.', code: 'GRIDSPACE_ACTION_UNAVAILABLE', id: '08645267-9b52-4683-b27b-91a42cd187e6' } },
	res: noteMenuResultSchema,
} as const;
export const paramDef = { type: 'object', properties: noteMenuProperties, required: ['noteId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private actions: GridspaceNoteMenuService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.actions.menu(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
