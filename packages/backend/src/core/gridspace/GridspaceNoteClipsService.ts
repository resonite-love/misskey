/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import { MiNote } from '@/models/Note.js';
import { MiClip } from '@/models/Clip.js';
import { MiClipNote } from '@/models/ClipNote.js';
import { MiGridspaceClipReference } from '@/models/GridspaceClipReference.js';
import { MiUser } from '@/models/User.js';
import { ClipEntityService } from '@/core/entities/ClipEntityService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspacePlacementActionService } from './GridspacePlacementActionService.js';
import { GridspacePublicNoteService } from './GridspacePublicNoteService.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { canonicalGridspaceNoteUri, gridspaceNoteUris } from './note-protocol.js';
import { GRIDSPACE_PRIVATE_SCOPE } from './link-crypto.js';
import type { NoteClipsRequest, NoteClipsPeerRequest, NoteClipsPeerResult } from './note-clips-protocol.js';

@Injectable()
export class GridspaceNoteClipsService {
	constructor(
		@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
		private clips: ClipEntityService, private links: GridspaceLinkService,
		private reader: GridspacePrivateService, private publicNotes: GridspacePublicNoteService,
		private channels: GridspaceChannelAuthService, private modules: ModuleRef,
		private placementActions: GridspacePlacementActionService,
	) {}

	private canonical(uri: string) { return canonicalGridspaceNoteUri(canonicalGridspaceNoteUri(uri, this.config.url), this.config.gridspace?.peerUrl); }
	private uri(note: MiNote) { return this.canonical(note.uri ?? `${new URL(this.config.url).origin}/notes/${note.id}`); }

	private async publicClips(noteId: string, viewer?: { id: string } | null, noteUri?: string): Promise<Packed<'Clip'>[]> {
		const query = () => this.db.getRepository(MiClip).createQueryBuilder('clip')
			.leftJoin(MiClipNote, 'membership', 'membership.clipId = clip.id AND membership.noteId = :noteId', { noteId })
			.leftJoin(MiGridspaceClipReference, 'reference', 'reference.clipId = clip.id AND reference.canonicalUri = :noteUri', { noteUri: noteUri ?? '' })
			.innerJoin(MiUser, 'owner', 'owner.id = clip.userId')
			.where('clip.isPublic = true AND owner.host IS NULL AND owner.isSuspended = false AND owner.isDeleted = false')
			.andWhere('(membership.id IS NOT NULL OR reference.id IS NOT NULL)')
			.orderBy('clip.id', 'DESC');
		const rows = await query().getMany();
		if (!rows.length) return [];
		const packed = await this.clips.packMany(rows, viewer);
		const fresh = new Set((await query().andWhere('clip.id IN (:...ids)', { ids: rows.map(clip => clip.id) }).getMany()).map(clip => clip.id));
		return packed.filter(clip => fresh.has(clip.id));
	}

	private async nativeNote(noteId: string, viewer: MiLocalUser | null) {
		const note = await this.modules.get<{ exec: (data: object, viewer: MiLocalUser | null, token: null) => Promise<Packed<'Note'>> }>('ep:notes/show', { strict: false }).exec({ noteId }, viewer, null);
		if (note.isHidden) throw new GridspaceLinkError('UNAVAILABLE');
		return note;
	}

	/** This route only reads this database, so aggregation cannot recurse. */
	public async peer(input: NoteClipsPeerRequest): Promise<NoteClipsPeerResult> {
		const origin = new URL(this.config.url).origin;
		let note: MiNote | null;
		if (input.noteId) note = await this.db.getRepository(MiNote).findOneBy({ id: input.noteId });
		else {
			if (!input.noteUri) throw new GridspaceLinkError('INVALID_REQUEST');
			const canonical = this.canonical(input.noteUri);
			const uri = new URL(canonical);
			const localId = uri.origin === origin && /^\/notes\/[a-zA-Z0-9]{1,32}$/.test(uri.pathname) && !uri.search && !uri.hash ? uri.pathname.slice(7) : null;
			note = await this.db.getRepository(MiNote).findOneBy(localId ? { id: localId } : { uri: In(gridspaceNoteUris(canonical, this.config.gridspace?.peerUrl)) });
		}
		if (!note) {
			const uri = input.noteUri && this.canonical(input.noteUri);
			const prefix = this.config.gridspace && new URL(this.config.gridspace.peerUrl).origin + '/notes/';
			if (!uri || !prefix || !uri.startsWith(prefix) || !input.accessToken) return { origin, noteId: input.noteId ?? '', noteUri: input.noteUri ?? '', clips: [] };
			const link = await this.links.authorizePrivate(input);
			const viewer = await this.db.getRepository(MiUser).findOneByOrFail({ id: link.localUserId }) as MiLocalUser;
			const check = async () => {
				await this.links.authorizePrivate(input);
				const page = await this.reader.notes(viewer, { mode: 'show', noteId: uri.slice(prefix.length), conversationUri: uri }, 1);
				if (!page.notes.some(note => note.uri === uri)) throw new GridspaceLinkError('UNAVAILABLE');
			};
			await check();
			const clips = await this.publicClips('', viewer, uri);
			await check();
			return { origin, noteId: uri.slice(prefix.length), noteUri: uri, clips };
		}
		const channelId = input.channelId ?? note.channelId ?? undefined;
		let viewer: { id: string } | undefined;
		const check = async () => {
			if (input.conversationUri || input.placementActorId) {
				viewer = (await this.placementActions.source(input, 'read')).user;
			} else if (input.channelActorId) {
				if (!channelId || input.accessToken) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				const actor = await this.channels.source(input.channelActorId);
				viewer = actor;
				if (!await this.reader.readableSourceNote(actor.id, note.id, undefined, channelId)) throw new GridspaceLinkError('UNAVAILABLE');
			} else if (input.accessToken || input.linkId || input.localUserId) {
				const link = await this.links.authorizePrivate(input);
				viewer = { id: link.localUserId };
				if (channelId && (link.initiator || this.config.gridspace?.channelRole !== 'source')) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				if (!await this.reader.readableSourceNote(link.localUserId, note.id, undefined, channelId)) throw new GridspaceLinkError('UNAVAILABLE');
			} else await this.publicNotes.local({ noteId: note.id, channelId });
		};
		await check();
		const clips = await this.publicClips(note.id, viewer, this.uri(note));
		await check();
		return { origin, noteId: note.id, noteUri: this.uri(note), clips };
	}

	private async credential(viewer: MiLocalUser, input: NoteClipsPeerRequest) {
		if (input.conversationUri) return this.placementActions.destination(viewer, input.conversationUri, input.noteId);
		if (input.channelId) return this.channels.destination(viewer);
		const link = await this.links.privateLink(viewer.id);
		return { credential: this.links.privateCredential(link), check: () => this.links.checkPrivateUnchanged(link) };
	}

	private async remote(input: NoteClipsPeerRequest, viewer: MiLocalUser | null, required: boolean) {
		let authorization: Awaited<ReturnType<GridspaceNoteClipsService['credential']>> | undefined;
		if (viewer) {
			try { authorization = await this.credential(viewer, input); } catch (error) { if (required) throw error; }
		}
		if (required && !authorization) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const result = await this.links.json<NoteClipsPeerResult>('/gridspace/v1/notes/clips', { ...input, ...authorization?.credential });
		if (authorization) await authorization.check();
		const origin = new URL(this.config.gridspace!.peerUrl).origin;
		if (result.origin !== origin || typeof result.noteUri !== 'string' || !Array.isArray(result.clips) || (input.noteId && result.noteId !== input.noteId) || (input.noteUri && this.canonical(result.noteUri) !== this.canonical(input.noteUri))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		if (input.conversationUri && this.canonical(result.noteUri) !== this.canonical(input.conversationUri)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		if (result.clips.some(clip => !clip.isPublic || !/^[a-zA-Z0-9]{1,32}$/.test(clip.id) || !/^[a-zA-Z0-9]{1,32}$/.test(clip.userId) || clip.user.host != null)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const uris = result.clips.map(clip => `${origin}/users/${clip.userId}`);
		const known = uris.length ? await this.db.getRepository(MiUser).findBy({ uri: In(uris) }) : [];
		return { ...result, check: async () => { if (authorization) await authorization.check(); }, clips: result.clips.map(clip => {
			const userId = known.find(user => user.uri === `${origin}/users/${clip.userId}`)?.id ?? `gridspace:${clip.userId}`;
			return { ...clip, gridspaceOrigin: origin, userId, user: { ...clip.user, id: userId, host: new URL(origin).host } };
		}) };
	}

	public async list(input: NoteClipsRequest, viewer: MiLocalUser | null, token: MiAccessToken | null = null): Promise<{ clips: Packed<'Clip'>[]; partial: boolean }> {
		const canDelegate = token == null || token.permission.includes(GRIDSPACE_PRIVATE_SCOPE);
		if (this.config.gridspace?.enabled && canDelegate) this.links.assertPrivateCaller(token);
		if (input.conversationUri && (input.source !== 'peer' || input.channelId)) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.source === 'peer') {
			if (!viewer || !this.config.gridspace?.enabled || !canDelegate) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			const target = { noteId: input.noteId, channelId: input.channelId, conversationUri: input.conversationUri };
			const check = async () => {
				const visible = await this.reader.notes(viewer, { mode: 'show', ...target }, 1);
				if (!visible.notes.some(note => note.id === input.noteId)) throw new GridspaceLinkError('UNAVAILABLE');
			};
			await check();
			// The source verifies the same delegated read grant as the note view.
			const remote = await this.remote(target, viewer, true);
			const canonical = this.canonical(remote.noteUri);
			const local = await this.db.getRepository(MiNote).findOneBy({ uri: In(gridspaceNoteUris(canonical, this.config.gridspace.peerUrl)) });
			const ownId = canonical.startsWith(new URL(this.config.url).origin + '/notes/') ? canonical.split('/').at(-1) : null;
			const localClips = await this.publicClips(local?.id ?? ownId ?? '', viewer, canonical);
			await remote.check();
			await check();
			return { clips: [...localClips, ...remote.clips], partial: false };
		}
		const note = await this.nativeNote(input.noteId, viewer);
		if (!this.config.gridspace?.enabled) {
			const clips = await this.publicClips(input.noteId, viewer);
			await this.nativeNote(input.noteId, viewer);
			return { clips, partial: false };
		}
		const uri = this.canonical(note.uri ?? `${new URL(this.config.url).origin}/notes/${note.id}`);
		if (![new URL(this.config.url).origin, new URL(this.config.gridspace.peerUrl).origin].includes(new URL(uri).origin)) {
			const clips = await this.publicClips(input.noteId, viewer);
			await this.nativeNote(input.noteId, viewer);
			return { clips, partial: false };
		}
		let remoteClips: Packed<'Clip'>[] = [];
		let partial = false;
		let recheck: (() => Promise<void>) | undefined;
		try {
			const remote = await this.remote({ noteUri: uri }, canDelegate ? viewer : null, false);
			recheck = remote.check;
			remoteClips = remote.clips;
		} catch { partial = true; }
		const local = await this.publicClips(input.noteId, viewer, uri);
		await this.nativeNote(input.noteId, viewer);
		try { await recheck?.(); } catch { remoteClips = []; partial = true; }
		return { clips: [...local, ...remoteClips], partial };
	}
}
