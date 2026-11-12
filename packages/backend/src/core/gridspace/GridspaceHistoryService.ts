/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import type { MiMeta } from '@/models/Meta.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceNoteService } from './GridspaceNoteService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { decodeHistoryCursor, encodeHistoryCursor, mergeHistory, validateHistoryPage, type HistoryOptions, type HistoryPeerRequest, type HistoryViewOptions } from './history-protocol.js';

import { filterNoteVisibility, noteNewerThanPolicySql, searchNoteTimeSql } from './search-visibility.js';

export class GridspaceHistoryError extends Error {
	constructor(public readonly code: 'LINK_UNAVAILABLE' | 'INVALID_CURSOR' | 'PEER_UNAVAILABLE') { super(code); }
}

@Injectable()
export class GridspaceHistoryService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly noteTime: string;

	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) config: Config,
		@Inject(DI.meta) private meta: MiMeta,
		private ids: IdService,
		private queries: QueryService,
		private users: UserEntityService,
		private notes: NoteEntityService,
		private people: ApPersonService,
		private sharedNotes: GridspaceNoteService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.noteTime = searchNoteTimeSql(config.id);
	}

	public async findLink(userId: string): Promise<MiGridspaceLink | null> {
		if (!this.peer) return null;
		const user = await this.db.getRepository(MiUser).findOneBy({ id: userId, isDeleted: false, isSuspended: false });
		if (!user) return null;
		const links = this.db.getRepository(MiGridspaceLink);
		if (user.host == null) return links.findOneBy({ localUserId: user.id, peerOrigin: this.peer.peerOrigin, state: 'active' });
		const prefix = this.peer.peerOrigin + '/users/';
		if (!user.uri?.startsWith(prefix)) return null;
		return links.findOneBy({ peerUserId: user.uri.slice(prefix.length), peerOrigin: this.peer.peerOrigin, state: 'active' });
	}

	private input(link: MiGridspaceLink, viewer: MiLocalUser | null, options: HistoryOptions, limit: number, before?: string): HistoryPeerRequest {
		return { userId: link.peerUserId, counterpartId: link.localUserId, linkId: link.id, generation: link.generation,
			viewerId: viewer?.id, withReplies: options.withReplies, withRenotes: options.withRenotes, withFiles: options.withFiles, limit, before };
	}

	private async remote(input: HistoryPeerRequest) {
		try {
			return validateHistoryPage(await requestGridspacePeer(this.peer!, '/gridspace/v1/history', input, 16384), input.limit, input.before);
		} catch { throw new GridspaceHistoryError('PEER_UNAVAILABLE'); }
	}

	public async member(userId: string, viewer: MiLocalUser | null) {
		const empty = { enabled: this.peer != null, linked: false, available: true, accounts: [] as Awaited<ReturnType<UserEntityService['pack']>>[] };
		const link = await this.findLink(userId);
		if (!link) return empty;
		try {
			const remote = await this.remote(this.input(link, viewer, { withReplies: false, withRenotes: false, withFiles: false }, 0));
			if (!remote.active || !await this.active(link)) return empty;
			const local = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, isDeleted: false, isSuspended: false });
			if (!local) return empty;
			const other = await this.people.resolvePerson(`${this.peer!.peerOrigin}/users/${link.peerUserId}`);
			if (other.isDeleted || other.isSuspended) return empty;
			return { ...empty, linked: true, accounts: [await this.users.pack(local, viewer), await this.users.pack(other, viewer)] };
		} catch (error) {
			if (error instanceof GridspaceHistoryError) return { ...empty, linked: true, available: false };
			throw error;
		}
	}

	private active(link: MiGridspaceLink) {
		return this.db.getRepository(MiGridspaceLink).existsBy({ id: link.id, generation: link.generation, state: 'active' });
	}

	private baseQuery(viewer: { id: string } | null, options: HistoryOptions) {
		const query = this.db.getRepository(MiNote).createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.channel', 'channel')
			.leftJoinAndSelect('note.reply', 'reply').leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('note.renote', 'renote').leftJoinAndSelect('renote.user', 'renoteUser');
		if (!options.withReplies) query.andWhere('note.replyId IS NULL');
		if (!options.withRenotes) query.andWhere('(note.renoteId IS NULL OR note.text IS NOT NULL OR note.fileIds != \'{}\' OR note.hasPoll = true)');
		if (options.withFiles) query.andWhere('note.fileIds != \'{}\'');
		this.queries.generateBaseNoteFilteringQuery(query, viewer);
		if (viewer) {
			query.andWhere('NOT EXISTS (SELECT 1 FROM blocking b WHERE b."blockerId" = :viewer AND b."blockeeId" = note."userId")', { viewer: viewer.id });
		}
		return query.orderBy('note.id', 'DESC');
	}

	private query(userId: string, viewer: { id: string } | null, options: HistoryOptions, before?: string, head?: string, authenticated = viewer != null) {
		// Only public/home posts cross the peer API, even when its authenticated visitor is unknown here.
		const query = this.baseQuery(viewer, options)
			.andWhere('note.userId = :author', { author: userId })
			.andWhere('note.channelId IS NULL')
			.andWhere('note.visibility IN (:...visibility)', { visibility: ['public', 'home'] });
		filterNoteVisibility(query, this.noteTime, viewer, true, authenticated);
		if (before) query.andWhere('note.id < :before', { before });
		if (head) query.andWhere('note.id <= :head', { head });
		return query;
	}

	private viewerQuery(link: MiGridspaceLink, viewer: MiLocalUser | null, options: HistoryViewOptions, includePeerPublic = false) {
		const query = this.baseQuery(viewer, options).andWhere(new Brackets(authors => {
			authors.where('note.userId = :localAuthor', { localAuthor: link.localUserId })
				.orWhere(new Brackets(peer => {
					peer.where('note.userId = ANY(ARRAY(SELECT peer_author.id FROM "user" peer_author WHERE peer_author.uri = :peerAuthor))', { peerAuthor: `${this.peer!.peerOrigin}/users/${link.peerUserId}` });
					// Public peer posts have their own source keyset. Only already-delivered restricted
					// posts join this server's keyset; linking never delegates the peer account's rights.
					if (!includePeerPublic) peer.andWhere(`(note.visibility IN ('followers', 'specified') OR note.channelId IS NOT NULL
						OR NOT ${noteNewerThanPolicySql(this.noteTime, 'makeNotesFollowersOnlyBefore')})`);
				}));
		}));
		filterNoteVisibility(query, this.noteTime, viewer, false);
		this.queries.generateVisibilityQuery(query, viewer);
		if (!viewer) this.queries.generateUgcVisibilityQueryForVisitor(query);
		if (!options.withChannelNotes) {
			query.andWhere('note.channelId IS NULL');
		} else {
			// Match profile timelines: sensitive channel posts are shown only to their author.
			query.andWhere('(note.channelId IS NULL OR channel.isSensitive = false OR note.userId = :channelAuthor)', { channelAuthor: viewer?.id ?? null });
		}
		if (viewer) {
			query.andWhere(`NOT EXISTS (SELECT 1 FROM channel_muting cm WHERE cm."userId" = :channelViewer
				AND (cm."channelId" = note."channelId" OR cm."channelId" = note."renoteChannelId")
				AND (cm."expiresAt" IS NULL OR cm."expiresAt" > CURRENT_TIMESTAMP))`, { channelViewer: viewer.id });
		}
		return query;
	}

	/** Only public/home source records cross this endpoint; a linked identity grants no private access. */
	public async peerHistory(input: HistoryPeerRequest) {
		if (!this.peer) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: input.linkId, generation: input.generation,
			localUserId: input.userId, peerUserId: input.counterpartId, peerOrigin: this.peer.peerOrigin, state: 'active' });
		const user = await this.db.getRepository(MiUser).findOneBy({ id: input.userId, isDeleted: false, isSuspended: false });
		if (!link || !user || user.host != null) return { active: false, items: [] };
		if (input.limit === 0) return { active: true, items: [] };
		if (!input.viewerId && this.meta.ugcVisibilityForVisitor === 'none') return { active: true, items: [] };
		// A signed peer assertion authenticates its local visitor, even before their actor is cached here.
		const viewer = input.viewerId ? await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${input.viewerId}` }) : null;
		const query = this.query(input.userId, viewer, input, input.before, input.head, input.viewerId != null);
		// Select the indexed keyset before hydrating relations. TypeORM take/getMany
		// otherwise builds a DISTINCT query over every selected relation column.
		const notes = await query.select('note.id', 'id').limit(input.limit).getRawMany<{ id: string }>();
		return { active: true, items: notes.map(note => ({ id: note.id, date: this.ids.parse(note.id).date.getTime() })) };
	}

	public async history(userId: string, viewer: MiLocalUser | null, options: HistoryViewOptions, limit: number, cursor?: string) {
		const link = await this.findLink(userId);
		if (!link || !this.peer) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const context = JSON.stringify(['viewer-history-v2', userId, viewer?.id ?? null, link.id, link.generation, options]);
		let position = { local: null as string | null, remote: null as string | null, localHead: null as string | null, remoteHead: null as string | null, expires: Date.now() + 3600000 };
		if (cursor) {
			try { position = decodeHistoryCursor(this.peer, cursor, context); } catch { throw new GridspaceHistoryError('INVALID_CURSOR'); }
		}
		const localQuery = this.viewerQuery(link, viewer, options);
		if (position.local) localQuery.andWhere('note.id < :before', { before: position.local });
		if (position.localHead) localQuery.andWhere('note.id <= :head', { head: position.localHead });
		if (cursor && position.localHead == null) localQuery.andWhere('1=0');
		// Both sources start together. A failed peer never advances either keyset.
		const [remote, local] = await Promise.all([
			this.remote({ ...this.input(link, viewer, options, cursor && position.remoteHead == null ? 0 : limit, position.remote ?? undefined), head: position.remoteHead ?? undefined }),
			localQuery.select('note.id', 'id').limit(limit).getRawMany<{ id: string }>(),
		]);
		if (!remote.active) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const remoteItems = !viewer && this.meta.ugcVisibilityForVisitor !== 'all' ? [] : remote.items;
		if (!cursor) {
			position.localHead = local[0]?.id ?? null;
			position.remoteHead = remoteItems[0]?.id ?? null;
		}
		const selected = mergeHistory(local.map(note => ({ id: note.id, date: this.ids.parse(note.id).date.getTime() })), remoteItems, limit);
		const mapped = new Map<string, string>();
		const budget = { remaining: 64, deadline: Date.now() + 15000 };
		try {
			// Re-read selected source objects in one bounded request, including deletions.
			const remoteNotes = await this.sharedNotes.historyNotes(selected.filter(item => item.source === 'remote').map(item => item.id), budget);
			for (const item of selected) {
				const id = item.source === 'local' ? item.id : remoteNotes.get(item.id)?.id;
				if (id) mapped.set(`${item.source}:${item.id}`, id);
			}
		} catch { throw new GridspaceHistoryError('PEER_UNAVAILABLE'); }
		if (!await this.active(link)) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const allowed = new Map<string, MiNote>();
		if (mapped.size > 0) {
			// Recheck current permissions and mutes after asynchronous imports, before packing any body.
			const query = this.viewerQuery(link, viewer, options, true).andWhere('note.id IN (:...ids)', { ids: [...mapped.values()] });
			for (const note of await query.getMany()) allowed.set(note.id, note);
		}
		const result: MiNote[] = [];
		for (const item of selected) {
			position[item.source] = item.id;
			const note = allowed.get(mapped.get(`${item.source}:${item.id}`) ?? '');
			if (note) result.push(note);
		}
		const hasMore = selected.length > 0 && (selected.length < local.length + remoteItems.length || local.length === limit || remoteItems.length === limit);
		return { notes: await this.notes.packMany(result, viewer), cursor: hasMore ? encodeHistoryCursor(this.peer, position, context) : null };
	}
}
