/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IsNull, type EntityManager } from 'typeorm';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NotePlacementService } from '@/core/NotePlacementService.js';
import { MiNote } from '@/models/Note.js';
import { MiChannel } from '@/models/Channel.js';
import { MiNoteChannelPlacement } from '@/models/NotePlacement.js';
import { MiGridspacePlacement, MiGridspacePlacementTarget } from '@/models/GridspacePlacement.js';
import { DI } from '@/di-symbols.js';
import type { Packed } from '@/misc/json-schema.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import type { PrivateNote } from './private-protocol.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceLinkError } from './GridspaceLinkService.js';
import { GridspacePublicNoteService } from './GridspacePublicNoteService.js';
import { parseChannelQuote, parsePlacementQuote, type PlacementQuote } from './quote-reference.js';

type Destination = { origin: string; channelId: string };
const rejected = () => new GridspaceLinkError('ACTION_REJECTED');

@Injectable()
export class GridspaceQuoteService {
	constructor(@Inject(DI.config) private config: Config, private reader: GridspacePrivateService, private modules: ModuleRef) {}

	public placementReference(value: string) {
		const peer = this.config.gridspace;
		const origins = peer?.enabled ? [this.config.url, new URL(peer.peerUrl).origin] : [this.config.url];
		try { return parsePlacementQuote(value, origins); } catch { throw rejected(); }
	}

	private async placementView(viewer: MiLocalUser | null, target: PlacementQuote): Promise<{ note: PrivateNote | null; localNote: Packed<'Note'> | null; publicUrl?: string }> {
		const local = new URL(target.canonicalUri).origin === this.config.url;
		if (!viewer) {
			if (local && !this.config.gridspace?.enabled) {
				const localNote = await this.modules.get(GridspacePublicNoteService).local({ noteId: target.noteId }, true);
				return { localNote, note: null, publicUrl: target.canonicalUri };
			}
			const result = await this.modules.get(GridspacePublicNoteService).resolve({ noteId: target.noteId }, local);
			return { localNote: result.note, note: null, publicUrl: result.publicUrl };
		}
		if (local) {
			const source = await this.modules.get(NotePlacementService).readable(viewer.id, target.noteId);
			if (!source || source.uri || source.user?.isSuspended || source.multiNoteKind !== 'root') throw rejected();
			const localNote = await this.modules.get(NoteEntityService).pack(source, viewer, { detail: true });
			if (localNote.isHidden) throw rejected();
			return { localNote, note: null };
		}
		const page = await this.reader.notes(viewer, { mode: 'show', noteId: target.noteId, conversationUri: target.canonicalUri }, 1);
		const note = page.notes.find(item => item.id === target.noteId && item.uri === target.canonicalUri && item.origin === new URL(target.canonicalUri).origin);
		if (!note) throw rejected();
		return { note, localNote: null };
	}

	public async resolvePlacement(viewer: MiLocalUser | null, target: PlacementQuote) {
		const result = await this.placementView(viewer, target);
		const note = result.note ?? result.localNote;
		if (!note && !viewer && result.publicUrl === target.canonicalUri) return result;
		if (!note || note.id !== target.noteId || (note.uri && note.uri !== target.canonicalUri) || note.multiNoteKind !== 'root' ||
			note.includeDefault !== false || !note.localOnly || !['public', 'home'].includes(note.visibility)) throw rejected();
		return result;
	}

	/** Hold all source rows owned by the writing server through the insert. Peer-owned rows get a fresh signed lookup. */
	private async lockPlacement(manager: EntityManager, target: PlacementQuote, external: boolean, destination?: Destination | null) {
		const localNote = new URL(target.canonicalUri).origin === this.config.url;
		const localChannel = target.sourceOrigin === this.config.url;
		const lock = { mode: 'pessimistic_read' as const };
		const where = { canonicalUri: target.canonicalUri, channelId: target.channelId, state: 'active' as const };
		if (localNote && !await manager.findOne(MiNote, { where: { id: target.noteId, uri: IsNull(), multiNoteKind: 'root', includeDefault: false }, lock })) throw rejected();
		if (localChannel) {
			// Staging locks a local destination as well. Acquire the lower ID first for opposite A→B / B→A quotes.
			if (destination?.origin === this.config.url && destination.channelId < target.channelId) {
				await manager.findOne(MiChannel, { where: { id: destination.channelId }, lock: { mode: 'for_no_key_update' } });
			}
			const channel = await manager.findOne(MiChannel, { where: { id: target.channelId }, lock: { mode: 'for_no_key_update' } });
			if (!channel || channel.isArchived || (external && !channel.allowRenoteToExternal)) throw rejected();
			if (channel.userId && !await manager.findOne(MiUser, { where: { id: channel.userId, isSuspended: false, isDeleted: false }, lock: { mode: 'for_no_key_update' } })) throw rejected();
			const row = localNote ? await manager.findOne(MiNoteChannelPlacement, { where: { ...where, noteId: target.noteId }, lock }) :
				await manager.findOne(MiGridspacePlacement, { where, lock });
			if (!row) throw rejected();
		} else if (localNote && !await manager.findOne(MiGridspacePlacementTarget, { where: { ...where, peerOrigin: target.sourceOrigin, noteId: target.noteId }, lock })) throw rejected();
	}

	public async prepare(viewer: MiLocalUser, value: string, destination?: Destination | string | null) {
		const placement = this.placementReference(value);
		if (placement) {
			const route = typeof destination === 'string' ? { origin: this.config.url, channelId: destination } : destination;
			const external = route?.origin !== placement.sourceOrigin || route.channelId !== placement.channelId;
			const check = async (manager?: EntityManager) => {
				if (!this.config.multiNote?.enabled) throw rejected();
				if (manager) await this.lockPlacement(manager, placement, external, route);
				const result = await this.resolvePlacement(viewer, placement);
				const note = result.note ?? result.localNote;
				const source = note?.channelPlacements?.find(row => row.canonicalUri === placement.canonicalUri && row.origin === placement.sourceOrigin &&
					row.channelId === placement.channelId && row.state === 'active');
				if (!note || !source || source.isArchived !== false || (external && source.allowRenoteToExternal !== true) ||
					((note.renoteId || note.gridspaceQuote) && !note.text && !note.cw && !note.files?.length && !note.poll)) throw rejected();
			};
			await check();
			return { url: placement.url, check, placement: true };
		}
		if (!this.config.gridspace?.enabled || this.config.gridspace.channelRole !== 'client') throw rejected();
		let target;
		try { target = parseChannelQuote(value, this.config.url); } catch { throw new GridspaceLinkError('ACTION_REJECTED'); }
		const check = async () => {
			const page = await this.reader.notes(viewer, { mode: 'show', noteId: target.noteId, channelId: target.channelId }, 1);
			const note = page.notes[0];
			if (!note || note.id !== target.noteId || note.channelId !== target.channelId || note.origin !== new URL(this.config.gridspace!.peerUrl).origin || note.uri !== `${note.origin}/notes/${target.noteId}` ||
				!note.canQuoteOutside || !['public', 'home'].includes(note.visibility)) throw new GridspaceLinkError('ACTION_REJECTED');
		};
		await check();
		return { url: target.url, check, placement: false };
	}
}
