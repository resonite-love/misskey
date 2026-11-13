/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';
import { GridspaceNoteService } from '@/core/gridspace/GridspaceNoteService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { gridspaceNoteId, canonicalGridspaceNoteUri } from '@/core/gridspace/note-protocol.js';

export const meta = {
	tags: ['notes'], requireCredential: true, secure: true, prohibitMoved: true,
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'This linked note cannot be renoted.', code: 'GRIDSPACE_RENOTE_UNAVAILABLE', id: 'f158f030-b88f-4eb6-b07e-96b1ae6f62c3' } },
	res: { type: 'object', optional: false, nullable: false, ref: 'Note' },
} as const;
export const paramDef = { type: 'object', properties: { noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } }, required: ['noteId'] } as const;

/** Resolve a delegated row to a real local Note before using normal Renote UI/APIs. */
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private reader: GridspacePrivateService, private notes: GridspaceNoteService,
		private apNotes: ApNoteService, private packer: NoteEntityService, private getter: GetterService, private utility: UtilityService,
		@Inject(DI.config) private config: Config,
	) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const page = await this.reader.notes(me, { mode: 'show', noteId: ps.noteId }, 1);
				const source = page.notes[0];
				if (!source || source.channelId || !['public', 'home'].includes(source.visibility)) throw new GridspaceLinkError('ACTION_REJECTED');
				const peerOrigin = new URL(source.origin).origin;
				const uri = canonicalGridspaceNoteUri(source.uri, peerOrigin);
				let target;
				if (uri.startsWith(peerOrigin + '/notes/') && gridspaceNoteId(uri.slice((peerOrigin + '/notes/').length))) {
					// The signed reader independently checks the author's current historical
					// restrictions. A delegated read grant alone never makes a note public.
					target = await this.notes.historyNote(uri.slice((peerOrigin + '/notes/').length), { remaining: 20, deadline: Date.now() + 10000 });
				} else if (uri.startsWith(this.config.url + '/notes/') && gridspaceNoteId(uri.slice((this.config.url + '/notes/').length))) {
					target = await this.getter.getNote(uri.slice((this.config.url + '/notes/').length));
				} else {
					// Third-party originals keep their normal ActivityPub identity and fetch path.
					if (source.localOnly || !this.utility.isFederationAllowedUri(uri)) throw new GridspaceLinkError('ACTION_REJECTED');
					target = await this.apNotes.resolveNote(uri);
				}
				if (!target || target.channelId || !['public', 'home'].includes(target.visibility) || (source.localOnly && !target.localOnly)) throw new GridspaceLinkError('ACTION_REJECTED');
				const packed = await this.packer.pack(target, me, { detail: true });
				if (packed.isHidden || !['public', 'home'].includes(packed.visibility)) throw new GridspaceLinkError('ACTION_REJECTED');
				// Reading/importing may involve network I/O; recheck the grant before responding.
				if (!(await this.reader.notes(me, { mode: 'show', noteId: ps.noteId }, 1)).notes.some(note => note.uri === source.uri && !note.channelId && ['public', 'home'].includes(note.visibility))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				return packed;
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
