/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NotePlacementService } from '@/core/NotePlacementService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';

export const meta = {
	tags: ['notes'], requireCredential: true, kind: 'write:notes',
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			status: { type: 'string', enum: ['missing', 'created', 'deleted'], optional: false, nullable: false },
			createdNote: { type: 'object', ref: 'Note', optional: false, nullable: true },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		clientRequestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
	},
	required: ['clientRequestId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private placements: NotePlacementService,
		private notes: NoteEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const { status, note } = await this.placements.status(me.id, ps.clientRequestId);
			return { status, createdNote: note ? await this.notes.pack(note, me) : null };
		});
	}
}
