/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import type { MiMeta } from '@/models/Meta.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { GridspaceNoteService } from './GridspaceNoteService.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { decodeHistoryCursor, encodeHistoryCursor, mergeHistory, validateHistoryPage } from './history-protocol.js';
import type { SearchOptions, SearchPeerRequest } from './search-protocol.js';
import { filterNoteVisibility, searchNoteTimeSql } from './search-visibility.js';

export class GridspaceSearchError extends Error {
	constructor(public readonly code: 'UNAVAILABLE' | 'INVALID_CURSOR' | 'LINK_UNAVAILABLE') { super(code); }
}

@Injectable()
export class GridspaceSearchService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly noteTime: string;
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) config: Config,
		@Inject(DI.meta) private meta: MiMeta,
		private ids: IdService,
		private queries: QueryService,
		private roles: RoleService,
		private users: UserEntityService,
		private notes: NoteEntityService,
		private people: ApPersonService,
		private sharedNotes: GridspaceNoteService,
		private history: GridspaceHistoryService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.noteTime = searchNoteTimeSql(config.id);
	}

	public info() { return { enabled: this.peer != null, origins: this.peer ? [this.peer.origin, this.peer.peerOrigin] : [] }; }

	public async read<T extends ObjectLiteral>(query: SelectQueryBuilder<T>): Promise<T[]> {
		const runner = this.db.createQueryRunner();
		try {
			await runner.startTransaction();
			await runner.query("SET LOCAL statement_timeout = '3s'");
			if (query.getParameters().gridspaceAuthorScoped === true) {
				// Keep the author scan ordered; a bitmap plan must collect and sort
				// all matches, even though this page only needs a handful of notes.
				await runner.query('SET LOCAL enable_bitmapscan = off');
			}
			// These queries join only to-one relations. TypeORM's take() pagination
			// otherwise DISTINCT-sorts every matching wide row before applying LIMIT.
			const bounded = query.clone();
			if (bounded.expressionMap.take != null) {
				bounded.limit(bounded.expressionMap.take).take(undefined);
			}
			const rows = await bounded.setQueryRunner(runner).getMany();
			await runner.commitTransaction();
			return rows;
		} finally {
			if (runner.isTransactionActive) await runner.rollbackTransaction();
			await runner.release();
		}
	}

	public userQuery(viewer: { id: string } | null) {
		const query = this.db.getRepository(MiUser).createQueryBuilder('user')
			.where('user.isDeleted = false AND user.isSuspended = false');
		if (this.meta.blockedHosts.length) query.andWhere('(user.host IS NULL OR user.host NOT ILIKE ALL(ARRAY[:...blocked]))', { blocked: this.meta.blockedHosts.flatMap(host => [host, `%.${host}`]) });
		if (viewer) {
			this.queries.generateBlockQueryForUsers(query, viewer);
			this.queries.generateMutedUserQueryForUsers(query, viewer);
			query.andWhere(`(user.host IS NULL OR NOT EXISTS (SELECT 1 FROM user_profile p WHERE p."userId" = :viewer
				AND p."mutedInstances"::jsonb ? user.host))`, { viewer: viewer.id });
		}
		return query.orderBy('user.id', 'DESC');
	}

	public noteQuery(viewer: { id: string } | null, options: SearchOptions, source: boolean, authenticated = viewer != null, channelId?: string, authorScoped = options.userId != null) {
		const query = this.db.getRepository(MiNote).createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.channel', 'channel')
			.leftJoinAndSelect('note.reply', 'reply').leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('note.renote', 'renote').leftJoinAndSelect('renote.user', 'renoteUser')
			.where('user.isDeleted = false')
			.setParameter('gridspaceAuthorScoped', authorScoped);
		// For an explicit author, use the author index before matching text. Common
		// one-character terms can otherwise materialize millions of PGroonga hits.
		if (options.query) query.andWhere(authorScoped
			? "((note.text || '') ILIKE :q OR (note.cw || '') ILIKE :q)"
			: '(note.text ILIKE :q OR (note.cw IS NOT NULL AND note.cw::text ILIKE :q))', { q: `%${sqlLikeEscape(options.query)}%` });
		this.queries.generateBaseNoteFilteringQuery(query, viewer);
		// These settings can hide an otherwise public note. Filter before matching/paging,
		// so neither an ID nor a continuation token reveals a match in hidden text.
		filterNoteVisibility(query, this.noteTime, viewer, source, authenticated);
		if (source) {
			query.andWhere("note.userHost IS NULL AND note.channelId IS NULL AND note.visibility IN ('public', 'home')");
		} else {
			this.queries.generateVisibilityQuery(query, viewer);
			// The general timeline helper also admits mentions. A mention alone is not
			// a recipient of a specified note and must not reveal a search match.
			query.andWhere("(note.visibility != 'specified' OR note.userId = :privacyViewer OR :privacyViewer = ANY(note.visibleUserIds))");
			if (!viewer) this.queries.generateUgcVisibilityQueryForVisitor(query);
			if (channelId) query.andWhere('note.channelId = :openedChannel', { openedChannel: channelId });
			else query.andWhere('(note.channelId IS NULL OR channel.isSensitive = false OR note.userId = :channelAuthor)', { channelAuthor: viewer?.id ?? null });
		}
		if (viewer) {
			query.andWhere(`NOT EXISTS (SELECT 1 FROM blocking b WHERE b."blockerId" = :viewer
				AND b."blockeeId" IN (note."userId", note."replyUserId", note."renoteUserId", renote."userId", renote."replyUserId", renote."renoteUserId"))`, { viewer: viewer.id });
			query.andWhere(`NOT EXISTS (SELECT 1 FROM channel_muting cm WHERE cm."userId" = :viewer
				${channelId ? 'AND cm."channelId" != :openedChannel' : ''}
				AND cm."channelId" IN (note."channelId", note."renoteChannelId")
				AND (cm."expiresAt" IS NULL OR cm."expiresAt" > CURRENT_TIMESTAMP))`);
		}
		if (options.rangeStartAt != null) query.andWhere('note.id > :start', { start: this.ids.gen(options.rangeStartAt - 1) });
		if (options.rangeEndAt != null) query.andWhere('note.id < :end', { end: this.ids.gen(options.rangeEndAt + 1) });
		return query.orderBy('note.id', 'DESC');
	}

	/** Authoritative search returns IDs only, after applying source-side access controls. */
	public async peerSearch(input: SearchPeerRequest) {
		if (!this.peer) throw new GridspaceSearchError('UNAVAILABLE');
		const viewer = input.viewerId ? await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${input.viewerId}` }) : null;
		const policies = await this.roles.getUserPolicies(viewer?.id ?? null);
		if (!(input.kind === 'notes' ? policies.canSearchNotes : policies.canSearchUsers)) throw new GridspaceSearchError('UNAVAILABLE');
		if (input.link && !await this.db.getRepository(MiGridspaceLink).existsBy({ id: input.link.id, generation: input.link.generation,
			localUserId: input.targetId, peerUserId: input.link.counterpartId, peerOrigin: this.peer.peerOrigin, state: 'active' })) return { active: false, items: [] };
		if (!input.viewerId && this.meta.ugcVisibilityForVisitor === 'none') return { active: true, items: [] };
		const query = input.kind === 'notes' ? this.noteQuery(viewer, input, true, input.viewerId != null, undefined, input.targetId != null) : this.userQuery(viewer).andWhere('user.host IS NULL');
		const alias = input.kind === 'notes' ? 'note' : 'user';
		if (input.kind === 'users' && !input.ids) query.andWhere('(user.name ILIKE :q OR user.username ILIKE :q)', { q: `%${sqlLikeEscape(input.query.replace(/^@/, ''))}%` });
		if (input.targetId) query.andWhere(`${input.kind === 'notes' ? 'note.userId' : 'user.id'} = :author`, { author: input.targetId });
		if (input.before) query.andWhere(`${alias}.id < :before`, { before: input.before });
		if (input.head) query.andWhere(`${alias}.id <= :head`, { head: input.head });
		if (input.ids) query.andWhere(`${alias}.id IN (:...ids)`, { ids: input.ids });
		if (input.limit === 0) return { active: true, items: [] };
		const rows = await this.read<MiNote | MiUser>(query.take(input.limit));
		return { active: true, items: rows.map(row => ({ id: row.id, date: this.ids.parse(row.id).date.getTime() })) };
	}

	private async remote(input: SearchPeerRequest, deadline = Date.now() + 8000) {
		return validateHistoryPage(await requestGridspacePeer(this.peer!, '/gridspace/v1/search', input, 16384, deadline), input.limit, input.before);
	}

	public async search(kind: 'notes' | 'users', options: SearchOptions, viewer: MiLocalUser | null, limit: number, cursor?: string) {
		if (!this.peer || !options.query.trim()) throw new GridspaceSearchError('UNAVAILABLE');
		if (kind === 'users' && (options.userId || options.rangeStartAt != null || options.rangeEndAt != null)) throw new GridspaceSearchError('UNAVAILABLE');
		options = { query: options.query.trim(), userId: options.userId, rangeStartAt: options.rangeStartAt, rangeEndAt: options.rangeEndAt };
		const policies = await this.roles.getUserPolicies(viewer?.id ?? null);
		if (!(kind === 'notes' ? policies.canSearchNotes : policies.canSearchUsers)) throw new GridspaceSearchError('UNAVAILABLE');
		const peer = this.peer;
		const peerHost = new URL(peer.peerOrigin).host;
		const link = options.userId ? await this.history.findLink(options.userId) : null;
		const author = options.userId ? await this.db.getRepository(MiUser).findOneBy({ id: options.userId, isDeleted: false, isSuspended: false }) : null;
		const counterpart = link ? await this.db.getRepository(MiUser).findOneBy({ uri: `${peer.peerOrigin}/users/${link.peerUserId}` }) : null;
		const authorIds = link ? [link.localUserId, ...(counterpart ? [counterpart.id] : [])] : options.userId ? [options.userId] : [];
		const targetId = link?.peerUserId ?? (author?.host === peerHost && author.uri?.startsWith(peer.peerOrigin + '/users/') ? author.uri.slice((peer.peerOrigin + '/users/').length) : undefined);
		const fetchPeer = (options.userId == null || targetId != null) && (viewer != null || this.meta.ugcVisibilityForVisitor === 'all');
		const input: SearchPeerRequest = { kind, query: options.query, rangeStartAt: options.rangeStartAt, rangeEndAt: options.rangeEndAt,
			viewerId: viewer?.id, targetId, limit, link: link ? { id: link.id, generation: link.generation, counterpartId: link.localUserId } : undefined };
		const context = JSON.stringify(['search-v1', kind, options, viewer?.id ?? null, link?.id, link?.generation, peer.origin, peer.peerOrigin]);
		let position = { local: null as string | null, remote: null as string | null, localHead: null as string | null, remoteHead: null as string | null, expires: Date.now() + 3600000 };
		if (cursor) {
			try { position = decodeHistoryCursor(peer, cursor, context); } catch { throw new GridspaceSearchError('INVALID_CURSOR'); }
		}
		const localNotes = (includePeerPublic = false) => {
			const query = this.noteQuery(viewer, options, false)
				.andWhere('(note.userHost IS NULL OR note.userHost = :peerHost)', { peerHost });
			if (!includePeerPublic) query.andWhere("(note.userHost IS NULL OR note.visibility IN ('followers', 'specified') OR note.channelId IS NOT NULL)");
			// Resolve linked actors before scanning notes, so both authors use the note.userId index.
			if (authorIds.length) query.andWhere('note.userId IN (:...authors)', { authors: authorIds });
			return query;
		};
		const localQuery = kind === 'notes' ? localNotes() : this.userQuery(viewer).andWhere('user.host IS NULL')
			.andWhere('(user.name ILIKE :q OR user.username ILIKE :q)', { q: `%${sqlLikeEscape(options.query.replace(/^@/, ''))}%` });
		const alias = kind === 'notes' ? 'note' : 'user';
		if (!viewer && this.meta.ugcVisibilityForVisitor === 'none') localQuery.andWhere('1=0');
		if (position.local) localQuery.andWhere(`${alias}.id < :before`, { before: position.local });
		if (position.localHead) localQuery.andWhere(`${alias}.id <= :head`, { head: position.localHead });
		if (cursor && !position.localHead) localQuery.andWhere('1=0');
		const local = await this.read<MiNote | MiUser>(localQuery.take(limit));
		let peerAvailable = true;
		let remote = { active: true, items: [] as { id: string; date: number }[] };
		if (fetchPeer) {
			try { remote = await this.remote({ ...input, before: position.remote ?? undefined, head: position.remoteHead ?? undefined, limit: cursor && !position.remoteHead ? 0 : limit }); } catch { peerAvailable = false; }
		}
		if (!remote.active) throw new GridspaceSearchError('LINK_UNAVAILABLE');
		if (!cursor) { position.localHead = local[0]?.id ?? null; position.remoteHead = remote.items[0]?.id ?? null; }
		const selected = mergeHistory(local.map(row => ({ id: row.id, date: this.ids.parse(row.id).date.getTime() })), remote.items, limit);
		const mapped = new Map<string, string>();
		const budget = { remaining: 64, deadline: Date.now() + 15000 };
		try {
			for (let offset = 0; offset < selected.length; offset += 4) {
				await Promise.all(selected.slice(offset, offset + 4).map(async item => {
					if (item.source === 'local') { mapped.set(`local:${item.id}`, item.id); return; }
					const row = kind === 'notes' ? await this.sharedNotes.historyNote(item.id, budget) : await this.people.resolvePerson(`${peer.peerOrigin}/users/${item.id}`);
					if (row) mapped.set(`remote:${item.id}`, row.id);
				}));
			}
			// Recheck the authoritative source after imports; neither stale caches nor a block race may expose a result.
			const remoteIds = selected.filter(item => item.source === 'remote').map(item => item.id);
			if (remoteIds.length) {
				const fresh = await this.remote({ ...input, ids: remoteIds });
				if (!fresh.active) throw new GridspaceSearchError('LINK_UNAVAILABLE');
				const allowed = new Set(fresh.items.map(item => item.id));
				for (const id of remoteIds) if (!allowed.has(id)) mapped.delete(`remote:${id}`);
			}
		} catch (error) {
			if (error instanceof GridspaceSearchError) throw error;
			peerAvailable = false;
		}
		if (link && !await this.db.getRepository(MiGridspaceLink).existsBy({ id: link.id, generation: link.generation, state: 'active' })) throw new GridspaceSearchError('LINK_UNAVAILABLE');
		if (!peerAvailable) for (const key of mapped.keys()) if (key.startsWith('remote:')) mapped.delete(key);
		if (link && !counterpart) {
			// The first imported result can create a previously uncached peer actor.
			const importedAuthor = await this.db.getRepository(MiUser).findOneBy({ uri: `${peer.peerOrigin}/users/${link.peerUserId}` });
			if (importedAuthor) authorIds.push(importedAuthor.id);
		}
		const allowed = new Map<string, MiNote | MiUser>();
		if (mapped.size) {
			const query = kind === 'notes' ? localNotes(true) : this.userQuery(viewer);
			query.andWhere(`${alias}.id IN (:...ids)`, { ids: [...mapped.values()] });
			for (const row of await this.read<MiNote | MiUser>(query)) allowed.set(row.id, row);
		}
		const results: (MiNote | MiUser)[] = [];
		for (const item of selected) {
			position[item.source] = item.id;
			const row = allowed.get(mapped.get(`${item.source}:${item.id}`) ?? '');
			if (row) results.push(row);
		}
		const userResults = [];
		if (kind === 'users') {
			const candidates = (results as MiUser[]).map(user => ({ user, accountIds: [] as string[], link: null as MiGridspaceLink | null }));
			const deadline = Date.now() + 8000;
			for (let offset = 0; offset < candidates.length && fetchPeer && peerAvailable; offset += 4) {
				await Promise.all(candidates.slice(offset, offset + 4).map(async candidate => {
					const currentLink = await this.history.findLink(candidate.user.id);
					if (!currentLink) return;
					try {
						const checked = await this.remote({ kind: 'users', query: options.query, viewerId: viewer?.id, targetId: currentLink.peerUserId,
							ids: [currentLink.peerUserId], limit: 1, link: { id: currentLink.id, generation: currentLink.generation, counterpartId: currentLink.localUserId } }, deadline);
						if (!checked.active || checked.items.length === 0) return;
						const counterpart = candidate.user.host == null
							? await this.db.getRepository(MiUser).findOneBy({ uri: `${peer.peerOrigin}/users/${currentLink.peerUserId}` })
							: await this.db.getRepository(MiUser).findOneBy({ id: currentLink.localUserId });
						candidate.link = currentLink;
						if (counterpart) candidate.accountIds = [counterpart.id];
					} catch { peerAvailable = false; }
				}));
			}
			const ids = [...new Set(candidates.flatMap(item => [item.user.id, ...item.accountIds]))];
			const currentUsers = ids.length ? await this.read(this.userQuery(viewer).andWhere('user.id IN (:...ids)', { ids })) : [];
			const peerIds = currentUsers.filter(user => user.host === peerHost).map(user => user.uri?.slice((peer.peerOrigin + '/users/').length)).filter((id): id is string => !!id);
			const authorizedPeerIds = new Set<string>();
			if (fetchPeer && peerAvailable) {
				try {
					for (let offset = 0; offset < peerIds.length; offset += 20) {
						const checked = await this.remote({ kind: 'users', query: options.query, viewerId: viewer?.id, ids: peerIds.slice(offset, offset + 20), limit: 20 });
						for (const item of checked.items) authorizedPeerIds.add(item.id);
					}
				} catch { peerAvailable = false; authorizedPeerIds.clear(); }
			}
			const safeUsers = new Map(currentUsers.filter(user => user.host == null || authorizedPeerIds.has(user.uri?.slice((peer.peerOrigin + '/users/').length) ?? '')).map(user => [user.id, user]));
			for (const candidate of candidates) {
				const user = safeUsers.get(candidate.user.id);
				if (!user) continue;
				const active = await this.history.findLink(user.id);
				const accounts = peerAvailable && active && active.id === candidate.link?.id && active.generation === candidate.link.generation
					? candidate.accountIds.map(id => safeUsers.get(id)).filter((account): account is MiUser => account != null) : [];
				userResults.push({ user: await this.users.pack(user, viewer), linkedAccounts: await this.users.packMany(accounts, viewer) });
			}
		}
		const hasMore = selected.length > 0 && (selected.length < local.length + remote.items.length || local.length === limit || remote.items.length === limit);
		return {
			notes: kind === 'notes' ? (await this.notes.packMany(results as MiNote[], viewer)).filter(note => !note.isHidden) : [], users: userResults, peerAvailable,
			// A partial page is a preview: retry the same cursor, without committing either keyset.
			cursor: peerAvailable ? (hasMore ? encodeHistoryCursor(peer, position, context) : null) : cursor ?? null,
		};
	}
}
