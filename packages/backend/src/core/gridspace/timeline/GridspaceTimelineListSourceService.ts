/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { type DataSource, type SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { defaultNoteCondition, noteListingCondition } from '@/misc/note-distribution.js';
import { MiNote } from '@/models/Note.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { IdService } from '@/core/IdService.js';
import { GridspaceHistoryService } from '../GridspaceHistoryService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { GridspaceSearchService } from '../GridspaceSearchService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from '../peer-protocol.js';
import { filterNoteVisibility, searchNoteTimeSql } from '../search-visibility.js';
import { canonicalGridspaceNoteUri, gridspaceNoteUris } from '../note-protocol.js';
import { TimelineLocalSource } from './TimelineLocalSource.js';
import { readSearchRows } from './search-page.js';
import type { TimelinePosition, TimelineReference } from './timeline-protocol.js';

export type TimelineListOptions =
	| { kind: 'profile'; userId: string; withReplies?: boolean; withRenotes?: boolean; withFiles?: boolean; withChannelNotes?: boolean }
	| { kind: 'search'; query: string; userId?: string; rangeStartAt?: number; rangeEndAt?: number }
	| { kind: 'mentions' | 'direct' };

/** Local half of P5; complete feeds also require the authoritative public peer source. */
@Injectable()
export class GridspaceTimelineListSourceService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly noteTime: string;
	private readonly origin: string;

	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		@Inject(DI.config) config: Config,
		private readonly queries: QueryService,
		private readonly roles: RoleService,
		private readonly search: GridspaceSearchService,
		private readonly history: GridspaceHistoryService,
		private readonly ids: IdService,
		private readonly localSource: TimelineLocalSource,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.noteTime = searchNoteTimeSql(config.id);
		this.origin = config.url;
	}

	public async buildQuery(viewer: MiLocalUser, options: TimelineListOptions, includePeerPublic = false, boundedSearch = false): Promise<SelectQueryBuilder<MiNote>> {
		if (viewer.isDeleted || viewer.isSuspended) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		let query: SelectQueryBuilder<MiNote>;
		if (options.kind === 'profile') query = await this.profileQuery(viewer, options, includePeerPublic);
		else if (options.kind === 'search') query = await this.searchQuery(viewer, options, includePeerPublic, boundedSearch);
		else if (options.kind === 'mentions' || options.kind === 'direct') {
			query = this.search.noteQuery(viewer, { query: '' }, false, true, undefined, false, true)
				.andWhere('(:listViewer::varchar[] <@ note.mentions OR :listViewer::varchar[] <@ note.visibleUserIds)', { listViewer: [viewer.id] });
			if (options.kind === 'direct') query.andWhere("note.visibility = 'specified'");
			this.queries.generateMutedNoteThreadQuery(query, viewer);
		} else throw new GridspaceLinkError('INVALID_REQUEST');
		return query.andWhere('EXISTS (SELECT 1 FROM "user" list_viewer WHERE list_viewer.id = :listActiveViewer AND list_viewer."isDeleted" = false AND list_viewer."isSuspended" = false)', { listActiveViewer: viewer.id });
	}

	private async profileQuery(viewer: MiLocalUser, options: Extract<TimelineListOptions, { kind: 'profile' }>, includePeerPublic: boolean): Promise<SelectQueryBuilder<MiNote>> {
		if (!options.userId || (options.withReplies && options.withFiles)) throw new GridspaceLinkError('INVALID_REQUEST');
		const link = await this.history.findLink(options.userId);
		if (link) {
			// Linking widens the author set, never the reader's permissions. Packing
			// reuses this query after hydration to catch a concurrent unlink/block.
			return this.history.viewerQuery(link, viewer, {
				withReplies: options.withReplies ?? false,
				withRenotes: options.withRenotes ?? true,
				withFiles: options.withFiles ?? false,
				withChannelNotes: options.withChannelNotes ?? false,
			}, includePeerPublic);
		}
		// Ordinary profiles intentionally show the author's posts despite an author
		// mute, like users/notes. Reply/renote authors and channel mutes still apply.
		const query = this.db.getRepository(MiNote).createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.channel', 'channel')
			.leftJoinAndSelect('note.reply', 'reply').leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('note.renote', 'renote').leftJoinAndSelect('renote.user', 'renoteUser')
			.where('note.userId = :listAuthor', { listAuthor: options.userId });
		// users/notes checks this before using excludeAuthor. Keep that protection
		// in the SQL scope so ownership and hydration cannot bypass an author block.
		query.andWhere('NOT EXISTS (SELECT 1 FROM blocking profile_block WHERE profile_block."blockerId" = :listAuthor AND profile_block."blockeeId" = :listSelf)', { listAuthor: options.userId, listSelf: viewer.id });
		this.queries.generateVisibilityQuery(query, viewer);
		this.queries.generateBaseNoteFilteringQuery(query, viewer, { excludeAuthor: true, excludeUserFromMute: options.userId });
		filterNoteVisibility(query, this.noteTime, viewer, false);
		query.andWhere("(note.visibility != 'specified' OR note.userId = :privacyViewer OR :privacyViewer = ANY(note.visibleUserIds))");
		if (this.peer && !includePeerPublic) query.andWhere(`(note.userHost IS NULL OR note.userHost != :profilePeerHost OR note.visibility IN ('followers', 'specified') OR NOT ${defaultNoteCondition()})`, { profilePeerHost: new URL(this.peer.peerOrigin).host });
		if (!options.withReplies) query.andWhere('note.replyId IS NULL');
		if (options.withFiles) query.andWhere('cardinality(note.fileIds) > 0');
		if (options.withRenotes === false) query.andWhere('((note.renoteId IS NULL AND note.gridspaceQuote IS NULL) OR note.text IS NOT NULL OR cardinality(note.fileIds) > 0 OR note.hasPoll = true)');
		query.andWhere(...noteListingCondition(options.withChannelNotes ? { kind: 'profile', viewerId: viewer.id } : { kind: 'default' }));
		query.andWhere(`NOT EXISTS (SELECT 1 FROM channel_muting cm WHERE cm."userId" = :listSelf
			AND cm."channelId" IN (note."channelId", note."renoteChannelId")
			AND (cm."expiresAt" IS NULL OR cm."expiresAt" > CURRENT_TIMESTAMP))`, { listSelf: viewer.id });
		return query;
	}

	private async searchQuery(viewer: MiLocalUser, options: Extract<TimelineListOptions, { kind: 'search' }>, includePeerPublic: boolean, boundedSearch: boolean): Promise<SelectQueryBuilder<MiNote>> {
		if (!options.query.trim() || options.query.length > 200) throw new GridspaceLinkError('INVALID_REQUEST');
		if (!(await this.roles.getUserPolicies(viewer.id)).canSearchNotes) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		// Discovery can use the text index; hydration checks an already-bounded
		// ID set, while author searches retain their ordered author index.
		const query = this.search.noteQuery(viewer, { ...options, query: options.query.trim() }, false, true, undefined, boundedSearch || options.userId != null);
		// Preserve Gridspace search's local/peer scope; unrelated federated hosts
		// are not an extra search source introduced by this adapter.
		if (this.peer) {
			query.andWhere('(note.userHost IS NULL OR note.userHost = :listPeerHost)', { listPeerHost: new URL(this.peer.peerOrigin).host });
			if (!includePeerPublic) query.andWhere(`(note.userHost IS NULL OR note.visibility IN ('followers', 'specified') OR NOT ${defaultNoteCondition()})`);
		}
		if (options.userId) {
			const link = await this.history.findLink(options.userId);
			const counterpart = link && this.peer ? await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${link.peerUserId}` }) : null;
			query.andWhere('note.userId IN (:...listAuthors)', { listAuthors: link ? [link.localUserId, ...(counterpart ? [counterpart.id] : [])] : [options.userId] });
		}
		return query;
	}

	public async read(viewer: MiLocalUser, options: TimelineListOptions, position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; limit: number; normalizedOnly?: boolean }): Promise<TimelineReference[]> {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = await this.buildQuery(viewer, options);
		if (position.untilAt != null) {
			if (!Number.isSafeInteger(position.untilAt) || position.untilAt < 0 || position.untilAt >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			query.andWhere('note.id < :listUntilAt', { listUntilAt: this.ids.gen(position.untilAt + 1) });
		}
		if (position.before) {
			if (!position.before.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(position.before.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere('note.id < :listBefore', { listBefore: position.before.noteId });
		}
		if (position.upper) {
			if (!position.upper.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(position.upper.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere('note.id <= :listUpper', { listUpper: position.upper.noteId });
		}
		const orderColumn = options.kind === 'mentions' || options.kind === 'direct' ? 'CONCAT(note.id)' : 'note.id';
		const notes = await this.search.read(query.select(['note.id', 'note.uri']).orderBy(orderColumn, 'DESC').limit(position.limit));
		return notes.map(note => this.reference({ noteId: note.id, uri: note.uri }));
	}

	/** Bounded candidate scans advance through empty permission-filtered pages. */
	public async readPage(viewer: MiLocalUser, options: TimelineListOptions, position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; limit: number }) {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 50) throw new GridspaceLinkError('INVALID_REQUEST');
		const windowSize = 512;
		const scan = this.db.getRepository(MiNote).createQueryBuilder('candidate').select(['candidate.id', 'candidate.uri']);
		const recipientList = options.kind === 'mentions' || options.kind === 'direct';
		if (recipientList) {
			scan.andWhere('(:listScanRecipient::varchar[] <@ candidate.mentions OR :listScanRecipient::varchar[] <@ candidate.visibleUserIds)', { listScanRecipient: [viewer.id] });
			if (options.kind === 'direct') scan.andWhere("candidate.visibility = 'specified'");
		}
		// Match notes/mentions so PostgreSQL uses the recipient indexes before
		// sorting, instead of scanning the whole timeline's primary key.
		const orderColumn = recipientList ? 'CONCAT(candidate.id)' : 'candidate.id';
		let authorIds: string[] | undefined;
		if ((options.kind === 'profile' || options.kind === 'search') && options.userId) {
			const link = await this.history.findLink(options.userId);
			const counterpart = link && this.peer ? await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${link.peerUserId}` }) : null;
			authorIds = link ? [link.localUserId, ...(counterpart ? [counterpart.id] : [])] : [options.userId];
		}
		if (options.kind === 'search') {
			const matches = await readSearchRows(this.search, await this.buildQuery(viewer, options), this.ids, position, authorIds);
			const references = matches.slice(0, position.limit).map(note => this.reference({ noteId: note.id, uri: note.uri }));
			const more = matches.length > position.limit;
			return { references, next: more ? references.at(-1)! : null, upper: position.upper ?? references[0] ?? null, ended: !more };
		}
		for (const [name, boundary, operator] of [['Before', position.before, '<'], ['Upper', position.upper, '<=']] as const) {
			if (!boundary) continue;
			if (!boundary.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			scan.andWhere(`candidate.id ${operator} :listScan${name}`, { [`listScan${name}`]: boundary.noteId });
		}
		if (position.untilAt != null) {
			if (!Number.isSafeInteger(position.untilAt) || position.untilAt < 0 || position.untilAt >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			scan.andWhere('candidate.id < :listScanUntil', { listScanUntil: this.ids.gen(position.untilAt + 1) });
		}
		const rows = authorIds ? (await Promise.all(authorIds.map(author => this.search.read(scan.clone().andWhere('candidate.userId = :listScanAuthor', { listScanAuthor: author }).orderBy('candidate.id', 'DESC').limit(windowSize + 1)))))
			.flat().sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0).slice(0, windowSize + 1)
			: await this.search.read(scan.orderBy(orderColumn, 'DESC').limit(windowSize + 1));
		const candidates = rows.map(note => ({ noteId: note.id, uri: note.uri }));
		const window = candidates.slice(0, windowSize);
		const upper = position.upper ?? (window[0] ? this.reference(window[0]) : null);
		if (!window.length) return { references: [], next: null, upper, ended: true };
		const query = (await this.buildQuery(viewer, options, false, true)).andWhere('note.id IN (:...listWindow)', { listWindow: window.map(note => note.noteId) });
		const eligible = await this.search.read(query.orderBy('note.id', 'DESC').limit(position.limit + 1));
		const references = eligible.slice(0, position.limit).map(note => this.reference({ noteId: note.id, uri: note.uri }));
		const hasMore = eligible.length > position.limit || candidates.length > windowSize;
		return { references, next: hasMore ? eligible.length > position.limit ? references.at(-1)! : this.reference(window.at(-1)!) : null, upper, ended: !hasMore };
	}

	/** Test local ownership with the same scope and fresh body authorization. */
	public async ownerReferences(viewer: MiLocalUser, options: TimelineListOptions, uris: string[], upper?: TimelinePosition | null): Promise<TimelineReference[]> {
		const references = await this.ownerCandidates(viewer, options, uris, upper);
		const allowed: TimelineReference[] = [];
		for (let offset = 0; offset < references.length; offset += 100) {
			allowed.push(...(await this.hydrate(viewer, options, references.slice(offset, offset + 100))).map(item => item.reference));
		}
		return allowed;
	}

	/** Current root ACL only; callers must hydrate before exposing any body. */
	public async ownerCandidates(viewer: MiLocalUser, options: TimelineListOptions, uris: string[], upper?: TimelinePosition | null): Promise<TimelineReference[]> {
		if (uris.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if (!uris.length || upper === null) return [];
		const prefix = `${this.origin}/notes/`;
		const ids = uris.filter(uri => uri.startsWith(prefix)).map(uri => uri.slice(prefix.length)).filter(id => /^[a-zA-Z0-9]{1,32}$/.test(id));
		const aliases = [...new Set(uris.flatMap(uri => gridspaceNoteUris(uri, this.peer?.peerOrigin)))];
		const query = await this.buildQuery(viewer, options, false, true);
		query.andWhere(`(note.uri IN (:...listOwnerUris)${ids.length ? ' OR note.id IN (:...listOwnerIds)' : ''})`, { listOwnerUris: aliases, listOwnerIds: ids });
		if (upper) {
			if (!upper.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(upper.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere('note.id <= :listOwnerUpper', { listOwnerUpper: upper.noteId });
		}
		const notes = await query.select('note.id', 'noteId').addSelect('note.uri', 'uri').limit(200).getRawMany<{ noteId: string; uri: string | null }>();
		const wanted = new Set(uris);
		const references = notes.map(note => this.reference(note)).filter(reference => wanted.has(reference.canonicalUri));
		return references;
	}

	private reference(note: { noteId: string; uri: string | null }): TimelineReference {
		return { noteId: note.noteId, canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.origin}/notes/${note.noteId}`, this.peer?.peerOrigin), sortAt: (BigInt(this.ids.parse(note.noteId).date.getTime()) * 1000n).toString(), normalized: true, generation: 1, source: 'local' };
	}

	public async hydrate(viewer: MiLocalUser, options: TimelineListOptions, references: TimelineReference[]) {
		return this.localSource.hydrateQuery(viewer, () => this.buildQuery(viewer, options, false, true), references);
	}

	public async hydrateImported(viewer: MiLocalUser, options: TimelineListOptions, references: TimelineReference[]) {
		return this.localSource.hydrateQuery(viewer, () => this.buildQuery(viewer, options, true, true), references);
	}
}
