/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, IsNull, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceReplyReceipt } from '@/models/Gridspace.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { GridspacePlacementService } from './GridspacePlacementService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceLinkError, GridspaceLinkService, type GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import { gridspaceHash } from './link-crypto.js';
import { dedicatedOriginal, originNoteId, type ConversationCredential } from './conversation-protocol.js';

type Input = ConversationCredential & GridspacePeerLinkRequest & { noteId?: string; channelId?: string };
type DeleteRequest = { actorId: string; canonicalUri: string; requestId: string };

@Injectable()
export class GridspacePlacementActionService {
	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
		private modules: ModuleRef, private links: GridspaceLinkService) {}

	public async destination(viewer: MiLocalUser, uri: string, noteId?: string) {
		const peerOrigin = this.config.gridspace && new URL(this.config.gridspace.peerUrl).origin;
		if (!peerOrigin || !noteId || originNoteId(uri, peerOrigin) !== noteId) throw new GridspaceLinkError('ACTION_REJECTED');
		const placements = this.modules.get(GridspacePlacementService);
		if (!await placements.hasPeerCapability()) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const { actorId } = await placements.currentActorCredential(viewer);
		return { credential: { placementActorId: actorId }, peerOrigin, peerUserId: '', key: 'placement:' + actorId,
			check: async () => { await placements.currentActorCredential(viewer); } };
	}

	private async readableOriginal(userId: string, noteId: string, manager?: EntityManager) {
		const search = this.modules.get(GridspaceSearchService);
		const query = search.noteQuery({ id: userId }, { query: '' }, false, true, undefined, true, false, noteId)
			.andWhere("note.uri IS NULL AND note.channelId IS NULL AND note.visibility IN ('public', 'home')");
		return manager?.queryRunner ? await query.setQueryRunner(manager.queryRunner).getOne() : (await search.read(query))[0];
	}

	public async source(input: Input, purpose: 'read' | 'reply' | 'upload' | 'vote' | 'reaction', manager?: EntityManager) {
		if (!input.placementActorId || !input.conversationUri || !input.noteId || input.channelId || input.channelActorId || input.linkId ||
			input.accessToken || input.generation || input.localUserId || input.pairId || originNoteId(input.conversationUri, this.config.url) !== input.noteId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const placements = this.modules.get(GridspacePlacementService);
		if (!(purpose === 'read' ? await placements.hasPeerCapability() : await placements.peerEnabled())) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = await placements.resolveActor(input.placementActorId, manager);
		const note = await this.readableOriginal(user.id, input.noteId, manager);
		if (!note || (!dedicatedOriginal(note) && !(note.userHost == null && (note.multiNoteKind === 'root' || (note.gridspaceShared && note.localOnly))))) throw new GridspaceLinkError('ACTION_REJECTED');
		if (purpose === 'vote' && !note.localOnly || purpose === 'reaction' && !dedicatedOriginal(note)) throw new GridspaceLinkError('ACTION_REJECTED');
		if (purpose === 'reply' || purpose === 'upload') {
			if (!dedicatedOriginal(note)) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
			const root = note.multiNoteKind === 'root' ? note : await this.readableOriginal(user.id, note.multiNoteRootId!, manager);
			if (!root || !dedicatedOriginal(root) || root.multiNoteKind !== 'root') throw new GridspaceLinkError('REPLY_UNAVAILABLE');
			await placements.authorizeConversationWrite(user, root, purpose, manager);
		}
		return { user, note };
	}

	public async deleteReply(viewer: MiLocalUser, canonicalUri: string, requestId: string) {
		const peerOrigin = this.config.gridspace && new URL(this.config.gridspace.peerUrl).origin;
		const noteId = peerOrigin && originNoteId(canonicalUri, peerOrigin);
		if (!noteId) throw new GridspaceLinkError('ACTION_REJECTED');
		const actor = await this.destination(viewer, canonicalUri, noteId);
		const result = await this.links.json<{ deleted: boolean }>('/gridspace/v1/placements/delete-reply', { actorId: actor.credential.placementActorId, canonicalUri, requestId });
		await actor.check();
		if (result.deleted !== true) throw new GridspaceLinkError('ACTION_REJECTED');
		return { deleted: true };
	}

	public async peerDeleteReply({ actorId, canonicalUri, requestId }: DeleteRequest) {
		const id = originNoteId(canonicalUri, this.config.url);
		if (!id) throw new GridspaceLinkError('ACTION_REJECTED');
		const placements = this.modules.get(GridspacePlacementService);
		if (!await placements.hasPeerCapability()) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = await placements.resolveActor(actorId);
		const receiptKey = { userId: user.id, requestId };
		const requestHash = gridspaceHash(JSON.stringify(['delete-reply', user.uri, id]));
		const checkReceipt = async (manager: EntityManager) => {
			const previous = await manager.findOneBy(MiGridspaceReplyReceipt, receiptKey);
			if (previous && (previous.requestHash !== requestHash || previous.noteId !== id)) throw new GridspaceLinkError('REPLY_CONFLICT');
			return !!previous;
		};
		if (await checkReceipt(this.db.manager)) return { deleted: true };
		const filter = { id, userId: user.id, uri: IsNull(), multiNoteKind: 'conversation-reply' as const, includeDefault: false, localOnly: true, channelId: IsNull() };
		const note = await this.db.manager.findOneBy(MiNote, filter);
		if (!note) {
			if (await checkReceipt(this.db.manager)) return { deleted: true };
			throw new GridspaceLinkError('ACTION_REJECTED');
		}
		await this.modules.get(NoteDeleteService).delete(user, note, false, undefined, async manager => {
			await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['delete-reply:' + user.id + ':' + requestId]);
			const current: MiUser = await placements.resolveActor(actorId, manager);
			if (current.id !== user.id || current.uri !== user.uri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			if (await checkReceipt(manager)) return;
			const fresh = await manager.findOne(MiNote, { where: filter, lock: { mode: 'pessimistic_write' } });
			if (!fresh || !dedicatedOriginal(fresh)) throw new GridspaceLinkError('ACTION_REJECTED');
			await manager.insert(MiGridspaceReplyReceipt, { ...receiptKey, noteId: id, requestHash });
		});
		return { deleted: true };
	}
}
