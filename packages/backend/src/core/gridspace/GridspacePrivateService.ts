/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiNote } from '@/models/Note.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiPoll } from '@/models/Poll.js';
import { MiFollowing } from '@/models/Following.js';
import type { MiMeta } from '@/models/Meta.js';
import { UtilityService } from '@/core/UtilityService.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './history-protocol.js';
import { gridspaceHash } from './link-crypto.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { searchNoteTimeSql } from './search-visibility.js';
import { PRIVATE_FILE_LIMIT, type PrivateNote, type PrivateWireNote, type PrivateOptions, type PrivatePage, type PrivatePeerRequest } from './private-protocol.js';

@Injectable()
export class GridspacePrivateService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly noteTime: string;
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) config: Config,
		@Inject(DI.meta) private meta: MiMeta,
		private utility: UtilityService,
		private links: GridspaceLinkService,
		private search: GridspaceSearchService,
		private history: GridspaceHistoryService,
		private ids: IdService,
		private roles: RoleService,
		private http: HttpRequestService,
		private storage: InternalStorageService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.noteTime = searchNoteTimeSql(config.id);
	}

	private query(viewerId: string, input: Partial<PrivatePeerRequest> = {}) {
		const mode = input.mode === 'validate' ? input.contextMode : input.mode;
		const query = this.search.noteQuery({ id: viewerId }, { query: input.query ?? '', rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt }, false);
		if (mode && mode !== 'show') {
			query.andWhere(`(note.visibility IN ('followers', 'specified') OR ("user"."makeNotesFollowersOnlyBefore" IS NOT NULL
				AND ${this.noteTime} <= CASE WHEN "user"."makeNotesFollowersOnlyBefore" > 0 THEN "user"."makeNotesFollowersOnlyBefore"::bigint * 1000
				ELSE :nowMs::bigint + "user"."makeNotesFollowersOnlyBefore"::bigint * 1000 END))`);
		}
		if (input.targetUris) query.andWhere('(COALESCE(user.uri, :origin || \'/users/\' || user.id) IN (:...targets))', { origin: this.peer!.origin, targets: input.targetUris });
		if (mode === 'home') query.andWhere('(note.userId = :oldViewer OR EXISTS (SELECT 1 FROM following f WHERE f."followerId" = :oldViewer AND f."followeeId" = note."userId"))', { oldViewer: viewerId });
		if (input.withReplies === false) query.andWhere('note.replyId IS NULL');
		if (input.withRenotes === false) query.andWhere('note.renoteId IS NULL');
		if (input.withFiles) query.andWhere('cardinality(note.fileIds) > 0');
		if (input.withChannelNotes === false) query.andWhere('note.channelId IS NULL');
		return query;
	}

	private async sourceNotes(viewerId: string, input: PrivatePeerRequest) {
		const query = this.query(viewerId, input);
		if (input.mode === 'show') query.andWhere('note.id = :noteId', { noteId: input.noteId });
		if (input.mode === 'validate') query.andWhere('note.id IN (:...ids)', { ids: input.ids });
		if (input.before) query.andWhere('note.id < :before', { before: input.before });
		if (input.head) query.andWhere('note.id <= :head', { head: input.head });
		return this.search.read(query.take(input.mode === 'validate' ? 100 : input.mode === 'show' ? 1 : (input.limit ?? 10) + 1));
	}

	private actor(user: MiUser) {
		return { name: user.name, username: user.username, host: user.host ?? new URL(this.peer!.origin).host, uri: user.uri ?? `${this.peer!.origin}/users/${user.id}` };
	}

	private async pack(note: MiNote, readableRelated: Set<string>): Promise<PrivateWireNote> {
		const files = note.fileIds.length ? await this.db.getRepository(MiDriveFile).findBy({ id: In(note.fileIds) }) : [];
		const poll = note.hasPoll ? await this.db.getRepository(MiPoll).findOneBy({ noteId: note.id }) : null;
		const actorIds = [note.userId, note.replyUserId, note.renoteUserId, note.renote?.replyUserId, note.renote?.renoteUserId].filter((id): id is string => !!id);
		const actors = await this.db.getRepository(MiUser).findBy({ id: In(actorIds) });
		return {
			id: note.id, origin: this.peer!.origin, createdAt: this.ids.parse(note.id).date.toISOString(), text: note.text, cw: note.cw,
			visibility: note.visibility, localOnly: note.localOnly,
			author: this.actor(note.user!), filterActors: actors.map(user => this.actor(user)),
			replyId: note.replyId && readableRelated.has(note.replyId) ? note.replyId : null,
			renoteId: note.renoteId && readableRelated.has(note.renoteId) ? note.renoteId : null,
			files: files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size, comment: file.comment, isSensitive: file.isSensitive || file.maybeSensitive })),
			poll: poll ? { choices: poll.choices.map((text, i) => ({ text, votes: poll.votes[i] ?? 0 })), expiresAt: poll.expiresAt?.toISOString() ?? null, multiple: poll.multiple } : null,
		};
	}

	/** No delegated body, attachment URL or search document is persisted. */
	public async peerNotes(input: PrivatePeerRequest): Promise<PrivatePage> {
		const link = await this.links.authorizePrivate(input);
		if ((input.query || input.mode === 'search' || input.contextMode === 'search') && (!(input.query?.trim()) || !(await this.roles.getUserPolicies(link.localUserId)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const rows = await this.sourceNotes(link.localUserId, input);
		const limit = input.mode === 'validate' ? 100 : input.mode === 'show' ? 1 : input.limit ?? 10;
		const selected = rows.slice(0, limit);
		const relatedIds = selected.flatMap(note => [note.replyId, note.renoteId]).filter((id): id is string => id != null);
		const related = relatedIds.length ? await this.search.read(this.query(link.localUserId).andWhere('note.id IN (:...related)', { related: relatedIds })) : [];
		const packed = await Promise.all(selected.map(note => this.pack(note, new Set(related.map(item => item.id)))));
		// Recheck after packing attachments/polls, not just before the asynchronous work.
		await this.links.authorizePrivate(input);
		const fresh = selected.length ? await this.search.read(this.query(link.localUserId, input).andWhere('note.id IN (:...selected)', { selected: selected.map(note => note.id) })) : [];
		const allowed = new Set(fresh.map(note => note.id));
		const freshRelated = relatedIds.length ? await this.search.read(this.query(link.localUserId).andWhere('note.id IN (:...related)', { related: relatedIds })) : [];
		const relatedAllowed = new Set(freshRelated.map(note => note.id));
		for (const note of packed) {
			if (note.replyId && !relatedAllowed.has(note.replyId)) note.replyId = null;
			if (note.renoteId && !relatedAllowed.has(note.renoteId)) note.renoteId = null;
		}
		await this.links.authorizePrivate(input);
		return { notes: packed.filter(note => allowed.has(note.id)), next: rows.length > limit ? selected.at(-1)!.id : null, head: input.head ?? selected[0]?.id ?? null };
	}

	private async localAllows(viewer: MiLocalUser, note: PrivateWireNote, home: boolean, peerUserId: string) {
		const profile = await this.db.getRepository(MiUserProfile).findOneBy({ userId: viewer.id });
		for (const actor of note.filterActors) {
			if (this.utility.isBlockedHost(this.meta.blockedHosts, actor.host) || profile?.mutedInstances.includes(actor.host)) return false;
			const where = actor.uri.startsWith(`${this.peer!.origin}/users/`) ? { id: actor.uri.slice(`${this.peer!.origin}/users/`.length), host: IsNull() } : { uri: actor.uri };
			const local = await this.db.getRepository(MiUser).findOneBy(where);
			if (local && !(await this.search.userQuery(viewer).andWhere('user.id = :author', { author: local.id }).getOne())) return false;
		}
		const uri = note.author.uri;
		const where = uri.startsWith(`${this.peer!.origin}/users/`) ? { id: uri.slice(`${this.peer!.origin}/users/`.length), host: IsNull() } : { uri };
		const local = await this.db.getRepository(MiUser).findOneBy(where);
		if (home && uri !== `${this.peer!.peerOrigin}/users/${peerUserId}` && local?.id !== viewer.id) {
			if (!local || !(await this.db.getRepository(MiFollowing).existsBy({ followerId: viewer.id, followeeId: local.id }))) return false;
		}
		return true;
	}

	private async targets(userId: string) {
		const user = await this.db.getRepository(MiUser).findOneBy({ id: userId });
		if (!user) throw new GridspaceLinkError('UNAVAILABLE');
		const targets = [user.uri ?? `${this.peer!.origin}/users/${user.id}`];
		const link = await this.history.findLink(userId);
		if (link) targets.push(`${this.peer!.peerOrigin}/users/${link.peerUserId}`, `${this.peer!.origin}/users/${link.localUserId}`);
		return [...new Set(targets)];
	}

	public async notes(viewer: MiLocalUser, input: PrivateOptions, limit: number, cursor?: string) {
		const link = await this.links.privateLink(viewer.id);
		const credential = this.links.privateCredential(link);
		if ((input.query || input.mode === 'search' || input.contextMode === 'search') && (!input.query?.trim() || !(await this.roles.getUserPolicies(viewer.id)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if ((input.mode === 'profile' && !input.userId) || (input.mode === 'show' && !input.noteId) || (input.mode === 'validate' && !input.ids?.length)) throw new GridspaceLinkError('INVALID_REQUEST');
		const options: PrivateOptions = {
			mode: input.mode, contextMode: input.contextMode, query: input.query?.trim(), userId: input.userId, noteId: input.noteId,
			ids: input.ids, rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt,
			withReplies: input.withReplies ?? true, withRenotes: input.withRenotes ?? true, withFiles: input.withFiles ?? false, withChannelNotes: input.withChannelNotes ?? true,
		};
		const targetUris = input.userId ? await this.targets(input.userId) : undefined;
		const context = `private:${viewer.id}:${link.id}:${link.generation}:${gridspaceHash(link.privateTokenCipher!)}:${JSON.stringify({ options, targetUris })}`;
		let state;
		try { state = cursor ? decodeHistoryCursor(this.peer!, cursor, context) : { local: null, remote: null, localHead: null, remoteHead: null, expires: Date.now() + 3600_000 }; } catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
		const { userId: _userId, ...peerOptions } = options;
		const page = await this.links.json<PrivatePage>('/gridspace/v1/private/notes', {
			...credential, ...peerOptions, targetUris, before: state.remote ?? undefined, head: state.remoteHead ?? undefined, limit,
		});
		if (!Array.isArray(page.notes) || page.notes.length > (input.mode === 'validate' ? 100 : limit) || page.notes.some(note => note.origin !== this.peer!.peerOrigin)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const notes: PrivateNote[] = [];
		for (const note of page.notes) if (await this.localAllows(viewer, note, (input.contextMode ?? input.mode) === 'home', link.peerUserId)) {
			const { filterActors: _filterActors, ...display } = note;
			notes.push(display);
		}
		await this.links.checkPrivateUnchanged(link);
		const next = page.next ? encodeHistoryCursor(this.peer!, { ...state, remote: page.next, remoteHead: page.head }, context) : null;
		return { notes, cursor: next };
	}

	public async peerFile(input: PrivatePeerRequest) {
		const link = await this.links.authorizePrivate(input);
		const note = (await this.sourceNotes(link.localUserId, { ...input, mode: 'show' }))[0];
		if (!note || !input.fileId || !note.fileIds.includes(input.fileId)) throw new GridspaceLinkError('UNAVAILABLE');
		const file = await this.db.getRepository(MiDriveFile).findOneBy({ id: input.fileId });
		if (!file || file.size > PRIVATE_FILE_LIMIT) throw new GridspaceLinkError('UNAVAILABLE');
		let data: Buffer;
		if (file.storedInternal && file.accessKey) {
			const stream = this.storage.read(file.accessKey);
			const chunks: Buffer[] = [];
			let size = 0;
			try {
				for await (const chunk of stream) {
					size += chunk.length;
					if (size > PRIVATE_FILE_LIMIT) throw new GridspaceLinkError('UNAVAILABLE');
					chunks.push(chunk);
				}
			} finally { stream.destroy(); }
			data = Buffer.concat(chunks);
		} else {
			// DB-owned URL only, with the usual SSRF guard, timeout and streaming size cap.
			const response = await this.http.send(file.url, { timeout: 7000, size: PRIVATE_FILE_LIMIT });
			data = Buffer.from(await response.arrayBuffer());
		}
		await this.links.authorizePrivate(input);
		const fresh = (await this.sourceNotes(link.localUserId, { ...input, mode: 'show' }))[0];
		if (!fresh?.fileIds.includes(file.id) || !await this.db.getRepository(MiDriveFile).existsBy({ id: file.id })) throw new GridspaceLinkError('UNAVAILABLE');
		await this.links.authorizePrivate(input);
		return { data: data.toString('base64'), type: file.type };
	}

	public async file(viewer: MiLocalUser, noteId: string, fileId: string) {
		const link = await this.links.privateLink(viewer.id);
		const page = await this.notes(viewer, { mode: 'show', noteId }, 1);
		const note = page.notes[0];
		if (!note?.files.some(file => file.id === fileId)) throw new GridspaceLinkError('UNAVAILABLE');
		const result = await this.links.json<{ data: string; type: string }>('/gridspace/v1/private/file', { ...this.links.privateCredential(link), mode: 'show', noteId, fileId }, true, PRIVATE_FILE_LIMIT * 1.4);
		await this.links.checkPrivateUnchanged(link);
		if (!(await this.notes(viewer, { mode: 'show', noteId }, 1)).notes.some(current => current.id === noteId && current.files.some(file => file.id === fileId))) throw new GridspaceLinkError('UNAVAILABLE');
		return result;
	}
}
