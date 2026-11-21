/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import type { Packed } from '@/misc/json-schema.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { bindThis } from '@/decorators.js';
import { isRenotePacked, isQuotePacked, isReferenceRenotePacked } from '@/misc/is-renote.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import type { InternalEventTypes, EventTypesToEventPayload } from '@/core/GlobalEventService.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class ChannelChannel extends Channel {
	public readonly chName = 'channel';
	public static shouldShare = false;
	public static requireCredential = false as const;
	private channelId: string;
	private readonly recentMirrors = new Set<string>();

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private noteEntityService: NoteEntityService,
		private noteStreamingHidingService: NoteStreamingHidingService,
	) {
		super(request);
		//this.onNote = this.onNote.bind(this);
	}

	@bindThis
	public async init(params: JsonObject) {
		if (typeof params.channelId !== 'string') return;
		this.channelId = params.channelId;

		// Subscribe stream
		this.subscriber.on('notesStream', this.onNote);
		this.subscriber.on('internal', this.onPlacement);
	}

	@bindThis
	private async onPlacement(event: EventTypesToEventPayload<InternalEventTypes>) {
		if (event.type !== 'channelMirrorPlaced' || event.body.channelId !== this.channelId || this.recentMirrors.has(event.body.noteId)) return;
		const source = await this.placementNotes.findOneBy({ id: event.body.noteId });
		if (!source) return;
		const note = await this.noteEntityService.pack(source, this.user);
		if (!note.isHidden) await this.deliverNote(note);
	}

	@bindThis
	private async onNote(note: Packed<'Note'>) {
		// A remote mirror can arrive before or after the placement. Its channel event comes from the committed projection.
		if (note.uri && note.gridspaceShared) return;
		await this.deliverNote(note);
	}

	private async deliverNote(note: Packed<'Note'>) {
		if (!await this.hasLocalChannelPlacement(note, [this.channelId], true)) return;

		if (note.user.requireSigninToViewContents && this.user == null) return;
		if (note.renote && note.renote.user.requireSigninToViewContents && this.user == null) return;
		if (note.reply && note.reply.user.requireSigninToViewContents && this.user == null) return;

		if (!this.isNoteVisibleForMe(note)) return;
		if (this.isNoteMutedOrBlocked(note)) return;

		const filtered = await this.noteStreamingHidingService.filter(note, this.user?.id ?? null);
		if (!filtered) return;
		// eslint-disable-next-line no-param-reassign -- これ以降元の Note オブジェクトは見てはいけないので、いっそ再代入した方が安全
		note = filtered;

		const result = await this.noteEntityService.withMyRenoteReaction(note, this.user?.id ?? null);
		if (note.uri && note.gridspaceShared) {
			if (this.recentMirrors.has(note.id)) return;
			this.recentMirrors.add(note.id);
			if (this.recentMirrors.size > 512) this.recentMirrors.delete(this.recentMirrors.values().next().value!);
		}
		this.send('note', result);
	}

	/*
	 * ミュートとブロックされてるを処理する
	 */
	protected override isNoteMutedOrBlocked(note: Packed<'Note'>): boolean {
		// 流れてきたNoteがインスタンスミュートしたインスタンスが関わる
		if (isInstanceMuted(note, this.userMutedInstances)) return true;

		// 流れてきたNoteがミュートしているユーザーが関わる
		if (isUserRelated(note, this.userIdsWhoMeMuting)) return true;
		// 流れてきたNoteがブロックされているユーザーが関わる
		if (isUserRelated(note, this.userIdsWhoBlockingMe)) return true;

		// 流れてきたNoteがリノートをミュートしてるユーザが行ったもの
		if (((isRenotePacked(note) && !isQuotePacked(note)) || isReferenceRenotePacked(note)) && this.userIdsWhoMeMutingRenotes.has(note.user.id)) return true;

		// このソケットで見ているチャンネルがミュートされていたとしても、チャンネルを直接見ている以上は流すようにしたい
		// ただし、他のミュートしているチャンネルは流さないようにもしたい
		// ノート自体のチャンネルIDはonNoteでチェックしているので、ここではリノートのチャンネルIDをチェックする
		if (
			(note.renote) &&
			(note.renote.channelId !== this.channelId) &&
			(note.renote.channelId && this.mutingChannels.has(note.renote.channelId))
		) {
			return true;
		}

		return false;
	}

	@bindThis
	public dispose() {
		// Unsubscribe events
		this.subscriber.off('notesStream', this.onNote);
		this.subscriber.off('internal', this.onPlacement);
	}
}
