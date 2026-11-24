/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { NotesRepository, NoteThreadMutingsRepository, NoteFavoritesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { GridspaceNoteMenuService } from '@/core/gridspace/GridspaceNoteMenuService.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			isFavorited: {
				type: 'boolean',
				optional: false, nullable: false,
			},
			isMutedThread: {
				type: 'boolean',
				optional: false, nullable: false,
			},
			gridspaceDeleteTarget: {
				type: 'object', optional: true, nullable: false,
				properties: {
					noteId: { type: 'string', optional: false, nullable: false },
					actorUri: { type: 'string', optional: false, nullable: false },
					channelId: { type: 'string', optional: true, nullable: false },
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
	},
	required: ['noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private noteThreadMutingsRepository: NoteThreadMutingsRepository,

		@Inject(DI.noteFavoritesRepository)
		private noteFavoritesRepository: NoteFavoritesRepository,
		private gridspaceNoteMenu: GridspaceNoteMenuService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.notesRepository.findOneByOrFail({ id: ps.noteId });

			const [favorite, threadMuting, gridspaceDeleteTarget] = await Promise.all([
				this.noteFavoritesRepository.count({
					where: {
						userId: me.id,
						noteId: note.id,
					},
					take: 1,
				}),
				this.noteThreadMutingsRepository.count({
					where: {
						userId: me.id,
						threadId: note.threadId ?? note.id,
					},
					take: 1,
				}),
				this.gridspaceNoteMenu.deleteTarget(me, note),
			]);

			return {
				isFavorited: favorite !== 0,
				isMutedThread: threadMuting !== 0,
				...(gridspaceDeleteTarget ? { gridspaceDeleteTarget } : {}),
			};
		});
	}
}
