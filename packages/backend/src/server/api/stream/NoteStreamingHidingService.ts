/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { NotePlacementService } from '@/core/NotePlacementService.js';
import { deepClone } from '@/misc/clone.js';
import { isRenotePacked, isQuotePacked } from '@/misc/is-renote.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiUser } from '@/models/User.js';
import type { MiMeta } from '@/models/_.js';

/** Streamにおいて、ノートを隠す（hideNote）を適用するためのService */
@Injectable()
export class NoteStreamingHidingService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		private noteEntityService: NoteEntityService,
		@Inject('NotePlacementService')
		private notePlacementService: NotePlacementService,
	) {}

	private collectRenoteChain(note: Packed<'Note'>): Packed<'Note'>[] {
		const renoteChain: Packed<'Note'>[] = [];

		for (let current: Packed<'Note'> | null | undefined = note; current != null; current = current.renote) {
			renoteChain.push(current);
		}

		return renoteChain;
	}

	private collectPlacementNotes(note: Packed<'Note'>, result: Packed<'Note'>[] = []): Packed<'Note'>[] {
		if (note.multiNoteKind != null || (note.gridspaceShared && note.uri) || note.channelPlacements || note.channelPlacementsUnavailable) {
			result.push(note);
		}
		if (note.reply) this.collectPlacementNotes(note.reply, result);
		if (note.renote) this.collectPlacementNotes(note.renote, result);
		return result;
	}

	/**
	 * ストリーミング配信用にノートの内容を隠す（あるいはそもそも送信しない）判定及び処理を行う。
	 *
	 * 隠す処理が必要な場合は元のノートをクローンして変更を適用したものを返し、
	 * 送信すべきでない場合は `null` を返す。
	 * 変更が不要な場合は元のノートの参照をそのまま返す。
	 *
	 * @param note - 処理対象のノート
	 * @param meId - 閲覧者のユーザー ID （未ログインの場合は `null`）
	 * @returns 配信するノートオブジェクト、または配信スキップの場合は `null`
	 */
	@bindThis
	public async filter(note: Packed<'Note'>, meId: MiUser['id'] | null): Promise<Packed<'Note'> | null> {
		if (meId == null) {
			if (this.meta.ugcVisibilityForVisitor === 'none') return null;
			if (this.meta.ugcVisibilityForVisitor === 'local' && note.user.host != null) return null;
		}

		const renoteChain = this.collectRenoteChain(note);
		const shouldHide = await Promise.all(renoteChain.map(n => this.noteEntityService.shouldHideNote(n, meId)));
		const shouldHideReply = await Promise.all(renoteChain.map(n => n.reply ? this.noteEntityService.shouldHideNote(n.reply, meId) : false));

		if (!shouldHide.some(h => h) && !shouldHideReply.some(h => h) && this.collectPlacementNotes(note).length === 0) {
			// 隠す必要がない場合は元のノートをそのまま返す
			return note;
		}

		if (shouldHide.some(h => h) && renoteChain.some(n => isRenotePacked(n) && !isQuotePacked(n))) {
			// 純粋リノートの場合は配信をスキップする
			return null;
		}

		const clonedNote = deepClone(note);
		let currentCloned = clonedNote;

		for (let i = 0; i < renoteChain.length; i++) {
			if (shouldHide[i]) {
				this.noteEntityService.hideNote(currentCloned);
			}
			if (shouldHideReply[i] && currentCloned.reply) {
				this.noteEntityService.hideNote(currentCloned.reply);
			}
			currentCloned = currentCloned.renote!;
		}

		// The broadcast payload is shared. Resolve placement names and actions for this subscriber only.
		const candidates = this.collectPlacementNotes(clonedNote);
		const visibleIds = [...new Set(candidates.filter(n => !n.isHidden).map(n => n.id))];
		const routes = visibleIds.length ? await this.notePlacementService.pack(visibleIds, meId ? { id: meId } : null) : undefined;
		for (const n of candidates) {
			delete n.channelPlacements;
			delete n.channelPlacementsUnavailable;
			// A mirror's root marker comes from the origin's response for this viewer.
			if (n.gridspaceShared && n.uri) {
				if (!n.isHidden && routes?.rootNoteIds?.has(n.id)) n.multiNoteKind = 'root';
				else if (n.multiNoteKind === 'root') delete n.multiNoteKind;
			}
			if (n.isHidden) continue;
			const placements = routes?.get(n.id) ?? [];
			if (placements.length > 0 || n.multiNoteKind != null) n.channelPlacements = placements;
			if (routes?.unavailableNoteIds?.has(n.id)) n.channelPlacementsUnavailable = true;
		}

		return clonedNote;
	}
}
