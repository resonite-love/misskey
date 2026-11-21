/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiMeta } from '@/models/Meta.js';
import type { Packed } from '@/misc/json-schema.js';
import type { NotesRepository } from '@/models/_.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';

export type PublicNoteTarget = { noteId: string; channelId?: string };

@Injectable()
export class GridspacePublicNoteService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.meta) private meta: MiMeta,
		@Inject(DI.notesRepository) private notes: NotesRepository,
		private packer: NoteEntityService,
		private links: GridspaceLinkService,
	) {}

	/** No account or delegated credentials: apply the source's visitor policy. */
	public async local(target: PublicNoteTarget, standaloneRoot = false): Promise<Packed<'Note'>> {
		const source = await this.notes.findOne({ where: { id: target.noteId }, relations: { user: true, reply: { user: true }, renote: { user: true } } });
		const enabled = this.config.gridspace?.enabled && ['source', 'client'].includes(this.config.gridspace.channelRole ?? '');
		const standalone = standaloneRoot && !target.channelId && source?.multiNoteKind === 'root' && source.includeDefault === false && !source.uri && !source.userHost;
		if (!source || !source.user || (!enabled && !standalone) ||
			(source.channelId ?? undefined) !== target.channelId ||
			(target.channelId && this.config.gridspace?.channelRole !== 'source') ||
			!['public', 'home'].includes(source.visibility) || source.user?.requireSigninToViewContents ||
			source.user?.isSuspended || source.user?.isDeleted || this.meta.ugcVisibilityForVisitor === 'none' ||
			(this.meta.ugcVisibilityForVisitor === 'local' && source.userHost != null)) throw new GridspaceLinkError('UNAVAILABLE');
		const note = await this.packer.pack(source, null, { detail: true });
		if (note.isHidden || !['public', 'home'].includes(note.visibility)) throw new GridspaceLinkError('UNAVAILABLE');
		// The standard packer already hides private/expired related notes. Also
		// honor the server's local-only visitor policy for attached remote notes.
		const restrictRelated = (value: Packed<'Note'>) => {
			for (const key of ['reply', 'renote'] as const) {
				const related = value[key];
				if (!related) continue;
				if (related.isHidden || related.user.requireSigninToViewContents ||
					!['public', 'home'].includes(related.visibility) ||
					(this.meta.ugcVisibilityForVisitor === 'local' && related.user.host != null)) value[key] = null;
				else restrictRelated(related);
			}
		};
		restrictRelated(note);
		return note;
	}

	public async resolve(target: PublicNoteTarget, local: boolean) {
		const origin = local ? this.config.url : new URL(this.config.gridspace!.peerUrl).origin;
		const note = local ? await this.local(target) : await this.links.json<Packed<'Note'>>('/gridspace/v1/notes/public', target);
		if (note.id !== target.noteId || (note.channelId ?? undefined) !== target.channelId || note.isHidden ||
			!['public', 'home'].includes(note.visibility) || note.user.requireSigninToViewContents) throw new GridspaceLinkError('UNAVAILABLE');
		// A destination that hides remote content can still open the source page.
		// Return only its verified link, never the body, in that case.
		return { note: !local && this.meta.ugcVisibilityForVisitor !== 'all' ? null : note, publicUrl: `${origin}/notes/${target.noteId}` };
	}
}
