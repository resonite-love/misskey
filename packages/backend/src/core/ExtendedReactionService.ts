/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiExtendedNoteReaction } from '@/models/ExtendedNoteReaction.js';
import { MiNoteReaction } from '@/models/NoteReaction.js';
import { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { ReactionService } from '@/core/ReactionService.js';
import { GridspaceReactionDeliveryService } from '@/core/gridspace/GridspaceReactionDeliveryService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteReactionEntityService } from '@/core/entities/NoteReactionEntityService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { bindThis } from '@/decorators.js';

// UNION also hides overlaps created by legacy clients: one user per emoji.
const mergedReactions = `SELECT "noteId", "userId", reaction FROM note_reaction
	UNION SELECT "noteId", "userId", reaction FROM extended_note_reaction`;

@Injectable()
export class ExtendedReactionService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		private reactionService: ReactionService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
		private noteEntityService: NoteEntityService,
		private noteReactionEntityService: NoteReactionEntityService,
		private customEmojiService: CustomEmojiService,
		private notificationService: NotificationService,
		private reactionDelivery: GridspaceReactionDeliveryService,
	) {}

	@bindThis
	public async create(user: Pick<MiUser, 'id' | 'host' | 'isBot'>, note: MiNote, input: string, allowPeerNote = false) {
		await this.reactionService.withReactionLock(user.id, note.id, () => this.createUnlocked(user, note, input, allowPeerNote));
	}

	/** The caller must hold the ordinary reaction lock; peer access is checked by GridspaceReactionService. */
	public async createUnlocked(user: Pick<MiUser, 'id' | 'host' | 'isBot'>, note: MiNote, input: string, allowPeerNote = false) {
		if (user.host !== null || (note.userHost !== null && !allowPeerNote)) throw new IdentifiableError('extended-local-only');
		const reaction = await this.reactionService.resolveReaction(user, note, input);
		const primary = await this.db.getRepository(MiNoteReaction).findOneBy({ userId: user.id, noteId: note.id });
		const repository = this.db.getRepository(MiExtendedNoteReaction);
		const extras = await repository.findBy({ userId: user.id, noteId: note.id });
		if (primary?.reaction === reaction || extras.some(r => r.reaction === reaction)) {
			throw new IdentifiableError('51c42bb4-931a-456b-bff7-e5a8a70dd298');
		}
		if (extras.length + (primary ? 1 : 0) >= 16) throw new IdentifiableError('extended-reaction-limit');
		if (!primary && extras.length === 0) {
			// Only the first reaction uses the legacy path and federates.
			await this.reactionService.createUnlocked(user, note, reaction);
		} else {
			await this.reactionDelivery.mutate(note, manager => manager.insert(MiExtendedNoteReaction, { id: this.idService.gen(), userId: user.id, noteId: note.id, reaction }));
			if (note.userHost === null) this.notificationService.createNotification(note.userId, 'reaction', { noteId: note.id, reaction }, user.id);
		}
		this.globalEventService.publishNoteStream(note, 'extendedReactionUpdated', {});
	}

	@bindThis
	public async delete(user: Pick<MiUser, 'id' | 'host' | 'isBot'>, note: MiNote, input: string, allowPeerNote = false) {
		await this.reactionService.withReactionLock(user.id, note.id, () => this.deleteUnlocked(user, note, input, allowPeerNote));
	}

	/** The caller must hold the ordinary reaction lock. */
	public async deleteUnlocked(user: Pick<MiUser, 'id' | 'host' | 'isBot'>, note: MiNote, input: string, allowPeerNote = false) {
		if (user.host !== null || (note.userHost !== null && !allowPeerNote)) throw new IdentifiableError('extended-local-only');
		if (!await this.noteEntityService.isVisibleForMe(note, user.id)) {
			throw new IdentifiableError('68e9d2d1-48bf-42c2-b90a-b20e09fd3d48');
		}
		// Deletion must not re-apply current emoji permissions/acceptance.
		const reaction = input.startsWith(':') ? input.replace('@.:', ':') : this.reactionService.normalize(input);
		const primary = await this.db.getRepository(MiNoteReaction).findOneBy({ userId: user.id, noteId: note.id, reaction });
		const result = await this.reactionDelivery.mutate(note, manager => manager.delete(MiExtendedNoteReaction, { userId: user.id, noteId: note.id, reaction }));
		if (primary) await this.reactionService.deleteUnlocked(user, note);
		if (!primary && !result.affected) throw new IdentifiableError('60527ec9-b4cb-4a88-a6bd-32d3ad26817d');
		this.globalEventService.publishNoteStream(note, 'extendedReactionUpdated', {});
	}

	@bindThis
	public async show(noteIds: string[], me: { id: string } | null, skipCountsFor: ReadonlySet<string> = new Set()) {
		const notes = await this.db.getRepository(MiNote).findBy({ id: In(noteIds) });
		const visible = (await Promise.all(notes.map(async note => await this.noteEntityService.isVisibleForMe(note, me?.id ?? null) ? note : null)))
			.filter((note): note is MiNote => note !== null);
		const ids = visible.map(note => note.id);
		if (ids.length === 0) return [];
		// Paired snapshots already aggregate these notes; retain viewer-specific state.
		const countIds = ids.filter(id => !skipCountsFor.has(id));
		const counts: { noteId: string; reaction: string; count: string }[] = countIds.length ? await this.db.query(
			`SELECT "noteId", reaction, COUNT(*) AS count FROM (${mergedReactions}) r WHERE "noteId" = ANY($1::varchar[]) GROUP BY "noteId", reaction`, [countIds]) : [];
		const mine: { noteId: string; reaction: string }[] = me ? await this.db.query(
			`SELECT "noteId", reaction FROM (${mergedReactions}) r WHERE "noteId" = ANY($1::varchar[]) AND "userId" = $2 ORDER BY reaction`, [ids, me.id]) : [];
		const primary = me ? await this.db.getRepository(MiNoteReaction).findBy({ noteId: In(ids), userId: me.id }) : [];
		return Promise.all(visible.map(async note => {
			const primaryReaction = primary.find(r => r.noteId === note.id);
			const reactions = Object.fromEntries(counts.filter(r => r.noteId === note.id)
				.map(r => [this.reactionService.convertLegacyReaction(r.reaction), Number(r.count)]));
			const custom = Object.keys(reactions).filter(r => r.startsWith(':')).map(r => r.slice(1, -1));
			return {
				noteId: note.id,
				reactions,
				myReaction: primaryReaction ? this.reactionService.convertLegacyReaction(primaryReaction.reaction) : null,
				myReactions: mine.filter(r => r.noteId === note.id).map(r => this.reactionService.convertLegacyReaction(r.reaction)),
				reactionEmojis: await this.customEmojiService.populateEmojis(custom, note.userHost),
			};
		}));
	}

	@bindThis
	public async list(note: MiNote, me: { id: string } | null, type: string | null | undefined, limit: number, sinceId?: string, untilId?: string) {
		const reaction = type?.replace('@.:', ':');
		// Keep one stable row per user/emoji before applying pagination.
		const rows: MiNoteReaction[] = await this.db.query(`
			SELECT * FROM (
				SELECT DISTINCT ON ("userId", reaction) * FROM (
					SELECT id, "userId", "noteId", reaction FROM note_reaction WHERE "noteId" = $1
					UNION ALL SELECT id, "userId", "noteId", reaction FROM extended_note_reaction WHERE "noteId" = $1
				) r ORDER BY "userId", reaction, id
			) r WHERE ($2::varchar IS NULL OR reaction = $2)
				AND ($3::varchar IS NULL OR id > $3) AND ($4::varchar IS NULL OR id < $4)
			ORDER BY id ${sinceId ? 'ASC' : 'DESC'} LIMIT $5`, [note.id, reaction ?? null, sinceId ?? null, untilId ?? null, limit]);
		return this.noteReactionEntityService.packMany(rows, me);
	}
}
