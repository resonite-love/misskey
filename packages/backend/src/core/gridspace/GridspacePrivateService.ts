/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets, DataSource, In, IsNull, type QueryRunner, type SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiClip } from '@/models/Clip.js';
import { MiAntenna } from '@/models/Antenna.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { MiClipNote } from '@/models/ClipNote.js';
import { MiClipFavorite } from '@/models/ClipFavorite.js';
import { MiNoteFavorite } from '@/models/NoteFavorite.js';
import { ClipEntityService } from '@/core/entities/ClipEntityService.js';
import { MiNote } from '@/models/Note.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiPollVote } from '@/models/PollVote.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { MiPoll } from '@/models/Poll.js';
import { MiFollowing } from '@/models/Following.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import type { MiMeta } from '@/models/Meta.js';
import { UtilityService } from '@/core/UtilityService.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { QueryService } from '@/core/QueryService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { NotePlacementService } from '@/core/NotePlacementService.js';
import { GridspacePlacementActionService } from './GridspacePlacementActionService.js';
import { dedicatedOriginal } from './conversation-protocol.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceReactionService } from './GridspaceReactionService.js';
import { supportsGridspaceReactions } from './reaction-protocol.js';
import { canSelfRenote } from './reply-protocol.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './history-protocol.js';
import { gridspaceHash } from './link-crypto.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { searchNoteTimeSql } from './search-visibility.js';
import { canonicalGridspaceNoteUri, gridspaceNoteId } from './note-protocol.js';
import { fillPeerEmojiUrls } from './peer-emoji-url.js';
import { GridspacePeerAuthorizationError, requestGridspacePeer } from './peer-client.js';
import { PRIVATE_FILE_LIMIT, type PrivateNote, type PrivateWireNote, type PrivateOptions, type PrivatePage, type PrivatePeerRequest } from './private-protocol.js';
import { TimelineReferenceService } from './timeline/TimelineReferenceService.js';
import { TIMELINE_AUTHORIZATION_TTL_MS, type TimelineOptions, type TimelinePosition, type TimelineReference } from './timeline/timeline-protocol.js';
import { TimelinePublicListSource, type PublicListRequest } from './timeline/TimelinePublicListSource.js';

@Injectable()
export class GridspacePrivateService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly noteTime: string;
	private readonly collectionClient: boolean;
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
		private users: UserEntityService,
		private emojis: CustomEmojiService,
		private extendedReactions: GridspaceReactionService,
		private channelAuth: GridspaceChannelAuthService,
		private queries: QueryService,
		private clips: ClipEntityService,
		private timelineReferences: TimelineReferenceService,
		private fanout?: FanoutTimelineService,
		private events?: GlobalEventService,
		private publicLists?: TimelinePublicListSource,
		private placementActions?: GridspacePlacementActionService,
		private notePlacements?: NotePlacementService,
		private driveFiles?: DriveFileEntityService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.noteTime = searchNoteTimeSql(config.id);
		this.collectionClient = config.gridspace?.channelRole === 'client';
	}

	private async authorizeRead(input: PrivatePeerRequest) {
		if (input.placementActorId || input.conversationUri) {
			const mode = input.mode === 'validate' ? input.contextMode : input.mode;
			if ((mode !== 'show' && mode !== 'context') || (input.mode !== 'validate' && (input.contextMode || input.ids)) || input.targetUris || input.query || input.fileId || input.clipId || input.antennaId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			const { user } = await this.placementActions!.source(input, 'read');
			return { localUserId: user.id, initiator: false };
		}
		if (input.channelId || input.channelActorId) this.channelAuth.assertSource();
		if (!input.channelActorId) {
			const link = await this.links.authorizePrivate(input);
			const mode = input.mode === 'validate' ? input.contextMode : input.mode;
			if (mode === 'antenna' && (!input.antennaId || !await this.db.getRepository(MiAntenna).existsBy({ id: input.antennaId, userId: link.localUserId }))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			if (mode === 'favorites' || mode === 'clip') {
				if (link.initiator || !await this.links.hasCollectionScope(input, mode === 'favorites' ? 'favorites' : 'clips')) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			}
			return link;
		}
		const mode = input.mode === 'validate' ? input.contextMode : input.mode;
		if (!(mode === 'home' && !input.channelId && !input.targetUris) && (!input.channelId || (mode !== 'channel' && mode !== 'show' && mode !== 'context'))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return { localUserId: (await this.channelAuth.source(input.channelActorId)).id, initiator: false };
	}

	private query(viewerId: string, input: Partial<PrivatePeerRequest> = {}, authors?: Pick<MiUser, 'id' | 'makeNotesFollowersOnlyBefore'>[], includeSensitiveChannels = false, boundedSearch = false) {
		const mode = input.mode === 'validate' ? input.contextMode : input.mode;
		if ((mode === 'channel' && !input.channelId) || (input.channelId && mode !== 'channel' && mode !== 'show' && mode !== 'context')) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.order === 'oldest' && mode !== 'clip' && mode !== 'context') throw new GridspaceLinkError('INVALID_REQUEST');
		if ((mode === 'clip' && !input.clipId) || (input.clipId && mode !== 'clip')) throw new GridspaceLinkError('INVALID_REQUEST');
		if ((mode === 'antenna' && !input.antennaId) || (input.antennaId && mode !== 'antenna')) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = this.search.noteQuery({ id: viewerId }, { query: mode === 'clip' ? '' : input.query ?? '', rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt }, false, true, input.channelId, boundedSearch || !!input.targetUris?.length || !!input.ids?.length || !!input.noteId, includeSensitiveChannels || mode === 'home' || mode === 'mentions' || mode === 'direct' || mode === 'favorites' || mode === 'clip' || mode === 'antenna');
		if (input.conversationUri && mode === 'show') query.andWhere('note.id = :conversationId', { conversationId: input.noteId });
		const followedChannel = 'EXISTS (SELECT 1 FROM channel_following cf WHERE cf."followerId" = :homeChannelViewer AND cf."followeeId" = note."channelId")';
		if (mode === 'home') query.setParameter('homeChannelViewer', viewerId);
		if (mode === 'favorites') {
			query.innerJoinAndMapOne('note.gridspaceCollection', MiNoteFavorite, 'collection', 'collection.noteId = note.id AND collection.userId = :collectionViewer', { collectionViewer: viewerId });
			query.orderBy('collection.id', 'DESC');
		} else if (mode === 'clip') {
			query.innerJoin(MiClipNote, 'collection', 'collection.noteId = note.id AND collection.clipId = :collectionClip', { collectionClip: input.clipId });
			query.innerJoin(MiClip, 'collectionOwner', 'collectionOwner.id = collection.clipId AND (collectionOwner.userId = :collectionViewer OR collectionOwner.isPublic = true)', { collectionViewer: viewerId });
			query.orderBy('note.id', input.order === 'oldest' ? 'ASC' : 'DESC');
			for (const [index, word] of (input.query?.trim().split(/\s+/).filter(Boolean) ?? []).entries()) {
				const parameter = 'clipSearch' + index;
				query.andWhere(new Brackets(terms => {
					terms.where(`note.text ILIKE :${parameter}`, { [parameter]: '%' + sqlLikeEscape(word) + '%' })
						.orWhere(`note.cw ILIKE :${parameter}`, { [parameter]: '%' + sqlLikeEscape(word) + '%' });
				}));
			}
		} else if (mode === 'mentions' || mode === 'direct') {
			// Include public mentions too: delivery to the old account does not
			// imply delivery to the new one. Keep the visibility query above.
			query.andWhere('(:mentionViewer::varchar[] <@ note.mentions OR :mentionViewer::varchar[] <@ note.visibleUserIds)', { mentionViewer: [viewerId] });
			if (mode === 'direct') query.andWhere('note.visibility = \'specified\'');
			this.queries.generateMutedNoteThreadQuery(query, { id: viewerId });
			// As in notes/mentions, avoid a primary-key scan over the whole timeline.
			query.orderBy('CONCAT(note.id)', 'DESC');
		} else if (mode === 'home') {
			// A channel subscription is independent of following the author. Guests
			// have channel access only; linked readers also receive private home notes.
			const privateHome = `(note.channelId IS NULL AND (note.visibility IN ('followers', 'specified') OR ("user"."makeNotesFollowersOnlyBefore" IS NOT NULL
				AND ${this.noteTime} <= CASE WHEN "user"."makeNotesFollowersOnlyBefore" > 0 THEN "user"."makeNotesFollowersOnlyBefore"::bigint * 1000
				ELSE :nowMs::bigint + "user"."makeNotesFollowersOnlyBefore"::bigint * 1000 END)))`;
			query.andWhere(input.channelActorId ? followedChannel : `(${privateHome} OR ${followedChannel})`);
			this.queries.generateMutedNoteThreadQuery(query, { id: viewerId });
		} else if (mode && mode !== 'show' && mode !== 'channel' && mode !== 'context' && mode !== 'antenna' && authors?.every(author => author.makeNotesFollowersOnlyBefore == null)) {
			query.andWhere('note.visibility IN (\'followers\', \'specified\')');
		} else if (mode && mode !== 'show' && mode !== 'channel' && mode !== 'context' && mode !== 'antenna') {
			query.andWhere(`(note.visibility IN ('followers', 'specified') OR ("user"."makeNotesFollowersOnlyBefore" IS NOT NULL
				AND ${this.noteTime} <= CASE WHEN "user"."makeNotesFollowersOnlyBefore" > 0 THEN "user"."makeNotesFollowersOnlyBefore"::bigint * 1000
				ELSE :nowMs::bigint + "user"."makeNotesFollowersOnlyBefore"::bigint * 1000 END))`);
		}
		if (input.targetUris) query.andWhere(`note.userId IN (SELECT target.id FROM "user" target
			WHERE target.uri IN (:...targets) OR (target.host IS NULL AND :origin || '/users/' || target.id IN (:...targets)))`, { origin: this.peer!.origin, targets: input.targetUris });
		if (authors) query.andWhere('note.userId IN (:...resolvedAuthors)', { resolvedAuthors: authors.map(author => author.id) });
		// Home subscriptions belong to the destination account. The source checks
		// readability; localAllows checks current follows/requests after retrieval.
		if (input.withReplies === false) query.andWhere(mode === 'home'
			? '(note.replyId IS NULL OR note.replyUserId = note.userId OR note.replyUserId = :homeViewer OR note.replyUserId IN (SELECT id FROM "user" WHERE uri = :homePeerViewer))'
			: 'note.replyId IS NULL', { homeViewer: viewerId, homePeerViewer: `${this.peer!.peerOrigin}/users/${input.localUserId}` });
		if (input.withRenotes === false) query.andWhere(mode === 'home' ? '((note.renoteId IS NULL AND note.gridspaceQuote IS NULL) OR note.text IS NOT NULL OR note.cw IS NOT NULL OR note.replyId IS NOT NULL OR cardinality(note.fileIds) > 0 OR note.hasPoll)' : '(note.renoteId IS NULL AND note.gridspaceQuote IS NULL)');
		if (input.withFiles) query.andWhere('cardinality(note.fileIds) > 0');
		if (input.withChannelNotes === false) query.andWhere('note.channelId IS NULL');
		const pureRenote = '((note.renoteId IS NOT NULL OR note.gridspaceQuote IS NOT NULL) AND note.text IS NULL AND note.cw IS NULL AND note.replyId IS NULL AND cardinality(note.fileIds) = 0 AND NOT note.hasPoll)';
		if (input.timelineIncludeMyRenotes === false) query.andWhere(`(NOT ${pureRenote} OR note.userId != :timelineSelf)`, { timelineSelf: viewerId });
		if (input.timelineIncludeRenotedMyNotes === false) query.andWhere(`(NOT ${pureRenote} OR note.renoteUserId IS DISTINCT FROM :timelineSelf)`, { timelineSelf: viewerId });
		if (input.timelineIncludeLocalRenotes === false) query.andWhere(`NOT (${pureRenote} AND note.renoteId IS NOT NULL AND note.renoteUserHost IS NULL)`);
		return query;
	}

	/** Anchor-derived scopes prevent a channel guest from choosing arbitrary authors. */
	private async contextQuery(viewerId: string, input: PrivatePeerRequest) {
		if (input.conversationUri) {
			const { note } = await this.placementActions!.source(input, 'read');
			if (!dedicatedOriginal(note)) throw new GridspaceLinkError('UNAVAILABLE');
			const root = note.multiNoteKind === 'root' ? note.id : note.multiNoteRootId;
			return this.query(viewerId, { mode: 'show' })
				.andWhere("note.uri IS NULL AND note.localOnly = true AND note.includeDefault = false AND note.visibility IN ('public', 'home')")
				.andWhere("((note.id = :root AND note.multiNoteKind = 'root') OR (note.multiNoteRootId = :root AND note.multiNoteKind = 'conversation-reply'))", { root })
				.orderBy('note.id', input.order === 'oldest' ? 'ASC' : 'DESC');
		}
		if (!input.noteId || !input.contextScope || input.targetUris?.length || input.query || input.clipId || input.antennaId) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.contextScope !== 'channel' && input.contextScope !== 'user') throw new GridspaceLinkError('INVALID_REQUEST');
		const anchor = await this.readableSourceNote(viewerId, input.noteId, undefined, input.channelId);
		if (!anchor || (input.channelId && anchor.channelId !== input.channelId)) throw new GridspaceLinkError('UNAVAILABLE');
		const channelId = input.contextScope === 'channel' ? anchor.channelId : undefined;
		if (input.contextScope === 'channel' && !channelId) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = this.query(viewerId, { ...input, channelId: channelId ?? undefined });
		query.andWhere(`note.id ${input.order === 'oldest' ? '>' : '<'} :contextAnchor`, { contextAnchor: anchor.id });
		if (input.contextScope === 'user') {
			query.andWhere('note.userId = :contextAuthor AND note.channelId IS NULL', { contextAuthor: anchor.userId });
			if (input.channelActorId) query.andWhere("note.visibility IN ('public', 'home')");
		}
		return query.orderBy('note.id', input.order === 'oldest' ? 'ASC' : 'DESC');
	}

	private async sourceNotes(viewerId: string, input: PrivatePeerRequest) {
		let authors: Pick<MiUser, 'id' | 'makeNotesFollowersOnlyBefore'>[] | undefined;
		if (input.targetUris) {
			const prefix = `${this.peer!.origin}/users/`;
			authors = await this.db.getRepository(MiUser).find({
				select: { id: true, makeNotesFollowersOnlyBefore: true },
				where: [{ uri: In(input.targetUris) }, { host: IsNull(), id: In(input.targetUris.filter(uri => uri.startsWith(prefix)).map(uri => uri.slice(prefix.length))) }],
			});
			if (!authors.length) return [];
		}
		// Resolve author policies before planning the scan. The final body packing
		// still rechecks current visibility and authorization without this shortcut.
		const context = (input.contextMode ?? input.mode) === 'context';
		const query = context ? await this.contextQuery(viewerId, input) : this.query(viewerId, input, authors);
		if ((input.contextMode ?? input.mode) === 'antenna') {
			if (!this.fanout || !input.antennaId) throw new GridspaceLinkError('INVALID_REQUEST');
			const antenna = await this.db.getRepository(MiAntenna).findOneBy({ id: input.antennaId, userId: viewerId });
			if (!antenna) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			// Reading the shared timeline activates the same native collection.
			await this.db.getRepository(MiAntenna).update(antenna.id, { isActive: true, lastUsedAt: new Date() });
			if (!antenna.isActive) this.events?.publishInternalEvent('antennaUpdated', { ...antenna, isActive: true });
			const ids = await this.fanout.get(`antennaTimeline:${antenna.id}`, input.mode === 'validate' ? null : input.before ?? null, null);
			if (!ids.length) return [];
			query.andWhere('note.id IN (:...antennaNotes)', { antennaNotes: ids });
		}
		if (input.mode === 'show') query.andWhere('note.id = :noteId', { noteId: input.noteId });
		if (input.mode === 'validate') query.andWhere('note.id IN (:...ids)', { ids: input.ids });
		const order = (input.contextMode ?? input.mode) === 'favorites' ? 'collection' : 'note';
		const ascending = ['clip', 'context'].includes(input.contextMode ?? input.mode) && input.order === 'oldest';
		if (input.before) query.andWhere(`${order}.id ${ascending ? '>' : '<'} :before`, { before: input.before });
		if (input.head && !ascending) query.andWhere(`${order}.id <= :head`, { head: input.head });
		const limit = input.mode === 'validate' ? 100 : input.mode === 'show' ? 1 : (input.limit ?? 10) + 1;
		return authors && input.mode !== 'validate' && input.mode !== 'show'
			? this.search.readAuthorPage(query, authors.map(author => author.id), limit)
			: this.search.read(query.take(limit));
	}

	private async sourceHomePage(viewerId: string, input: PrivatePeerRequest) {
		// Sparse private timelines must not scan the entire federated note table
		// with visibility joins just to fill a page. Walk a bounded primary-key
		// window first, then apply the unchanged access controls to that window.
		const scanLimit = 512;
		const scan = this.db.getRepository(MiNote).createQueryBuilder('candidate').select('candidate.id', 'id');
		if (input.before) scan.andWhere('candidate.id < :before', { before: input.before });
		if (input.head) scan.andWhere('candidate.id <= :head', { head: input.head });
		if (input.rangeStartAt != null) scan.andWhere('candidate.id > :start', { start: this.ids.gen(input.rangeStartAt - 1) });
		if (input.rangeEndAt != null) scan.andWhere('candidate.id < :end', { end: this.ids.gen(input.rangeEndAt + 1) });
		const candidates = await scan.orderBy('candidate.id', 'DESC').limit(scanLimit + 1).getRawMany<{ id: string }>();
		const window = candidates.slice(0, scanLimit);
		if (!window.length) return { rows: [] as MiNote[], next: null, head: input.head ?? null, scannedThrough: null };
		const limit = input.limit ?? 10;
		const rows = await this.search.read(this.query(viewerId, input).andWhere('note.id IN (:...windowIds)', { windowIds: window.map(note => note.id) }).take(limit + 1));
		// Do not skip the unread tail when the window contains more than one page.
		const boundary = rows.length > limit ? rows[limit - 1].id : window.at(-1)!.id;
		return {
			rows, next: rows.length > limit || candidates.length > scanLimit ? boundary : null,
			head: input.head ?? window[0].id,
			scannedThrough: this.ids.parse(boundary).date.toISOString(),
		};
	}

	public async readableSourceNote(viewerId: string, noteId: string, runner?: QueryRunner, channelId?: string) {
		const query = this.query(viewerId, { mode: 'show', channelId }).andWhere('note.id = :noteId', { noteId });
		if (runner) return query.setQueryRunner(runner).getOne();
		return (await this.search.read(query))[0] ?? null;
	}

	private async readTimelineAnchor(query: SelectQueryBuilder<MiNote>, anchor: string): Promise<MiNote[]> {
		const prefix = `${this.peer!.origin}/notes/`;
		const id = anchor.startsWith(prefix) ? anchor.slice(prefix.length) : null;
		// A canonical local URL already contains its primary key. Concatenating
		// every row's URL prevents the database from using that index.
		return this.search.read(query.clone().andWhere(id && gridspaceNoteId(id)
			? 'note.id = :timelineAnchorId'
			: 'note.uri = :timelineAnchorUri', { timelineAnchorId: id, timelineAnchorUri: anchor }).limit(1));
	}

	/** Pair-authenticated reference paging; source authorization is rechecked before body reads. */
	public async peerTimeline(input: PrivatePeerRequest) {
		const mode = input.mode === 'validate' ? input.contextMode : input.mode;
		if (mode && mode !== 'home') return this.peerListTimeline(input);
		if (!mode || !['home', 'mentions', 'direct', 'channel'].includes(mode)) throw new GridspaceLinkError('INVALID_REQUEST');
		const link = await this.authorizeRead(input);
		if (input.channelId && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (input.query && (!input.query.trim() || !(await this.roles.getUserPolicies(link.localUserId)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const status = await this.timelineReferences.status();
		const sourceInput = link.initiator ? { ...input, withChannelNotes: false } : input;
		const authorizationStarted = Date.now();
		const changes = input.timelineSequence != null ? await this.timelineReferences.changes(input.timelineSequence, 100) : null;
		if (input.timelineValidate) {
			const page = input.ids?.length ? await this.peerNotes({ ...sourceInput, mode: 'validate', contextMode: mode }) : { notes: [] as PrivateWireNote[], next: null, head: null, scannedThrough: null, observedAt: new Date().toISOString() };
			const ids = [...new Set(changes?.events.flatMap(event => event.noteId ? [event.noteId] : []) ?? [])];
			const visible = ids.length ? await this.search.read(this.query(link.localUserId, { ...sourceInput, mode, contextMode: undefined }).andWhere('note.id IN (:...changedTimelineIds)', { changedTimelineIds: ids })) : [];
			const reference = (note: Pick<MiNote, 'id' | 'uri'>) => ({ noteId: note.id, canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.peer!.origin}/notes/${note.id}`, this.peer!.peerOrigin), sortAt: (BigInt(this.ids.parse(note.id).date.getTime()) * 1000n).toString(), normalized: true, generation: 1 });
			const visibleIds = new Set(visible.map(note => note.id));
			const policyChanged = changes?.events.some(event => !event.noteId && (!event.affectedUserId || event.affectedUserId === link.localUserId));
			const retainedIds = new Set(input.ids ?? []);
			const packedIds = page.notes.flatMap(note => [note.id, ...(note.renote ? [note.renote.id] : [])]);
			const policies = packedIds.length ? await this.search.read(this.query(link.localUserId, { mode: 'show' }, undefined, true).andWhere('note.id IN (:...leaseIds)', { leaseIds: packedIds })) : [];
			const finalAllowed = new Set(policies.map(note => note.id));
			page.notes = page.notes.filter(note => finalAllowed.has(note.id));
			for (const note of page.notes) if (note.renote && !finalAllowed.has(note.renote.id)) { delete note.renote; note.renoteId = null; }
			let validForMs = Math.max(0, TIMELINE_AUTHORIZATION_TTL_MS - (Date.now() - authorizationStarted));
			for (const note of policies) {
				if (note.userId === link.localUserId) continue;
				for (const [kind, policy] of [['hidden', note.user?.makeNotesHiddenBefore], ['followers', note.user?.makeNotesFollowersOnlyBefore]] as const) {
					if (policy != null && policy <= 0) {
						const cutoff = this.ids.parse(note.id).date.getTime() - policy * 1000;
						const remaining = cutoff - Date.now();
						if (remaining > 0) validForMs = Math.min(validForMs, remaining);
						else if (kind === 'hidden' || cutoff > authorizationStarted) validForMs = 0;
					}
				}
			}
			const nextSequence = changes?.cursor ?? await this.timelineReferences.currentPosition();
			await this.authorizeRead(input);
			return { ...page, references: page.notes.map(note => reference({ id: note.id, uri: note.uri })), newReferences: visible.filter(note => changes?.events.some(event => event.noteId === note.id && event.kind === 'insert')).map(reference), sequence: nextSequence, changed: changes ? changes.resetRequired || !!policyChanged || changes.events.some(event => event.noteId && (visibleIds.has(event.noteId) || retainedIds.has(event.noteId)) && event.kind !== 'insert') : false, generation: status.generation, validForMs };
		}
		const sequence = await this.timelineReferences.currentPosition();
		const query = this.query(link.localUserId, sourceInput);
		if (input.timelineAnchor) {
			const anchor = await this.readTimelineAnchor(query, input.timelineAnchor);
			await this.authorizeRead(input);
			return { references: anchor.map(note => ({ noteId: note.id, canonicalUri: note.uri ?? `${this.peer!.origin}/notes/${note.id}`, sortAt: (BigInt(this.ids.parse(note.id).date.getTime()) * 1000n).toString(), normalized: true, generation: 1 })), next: null, upper: null, sequence, generation: status.generation, changed: false };
		}
		if (input.timelineBefore?.noteId) query.andWhere('note.id < :timelineBeforeId', { timelineBeforeId: input.timelineBefore.noteId });
		if (input.timelineUpper?.noteId) query.andWhere('note.id <= :timelineUpperId', { timelineUpperId: input.timelineUpper.noteId });
		if (input.timelineUntilAt != null) query.andWhere('note.id < :timelineUntilId', { timelineUntilId: this.ids.gen(input.timelineUntilAt + 1) });
		const scan = this.db.getRepository(MiNote).createQueryBuilder('candidate').select(['candidate.id', 'candidate.uri']);
		if (input.timelineBefore?.noteId) scan.andWhere('candidate.id < :scanBefore', { scanBefore: input.timelineBefore.noteId });
		if (input.timelineUpper?.noteId) scan.andWhere('candidate.id <= :scanUpper', { scanUpper: input.timelineUpper.noteId });
		if (input.timelineUntilAt != null) scan.andWhere('candidate.id < :scanUntil', { scanUntil: this.ids.gen(input.timelineUntilAt + 1) });
		const candidates = await scan.orderBy('candidate.id', 'DESC').limit(513).getMany();
		const window = candidates.slice(0, 512);
		const rows = window.length ? await this.search.read(query.andWhere('note.id IN (:...timelineWindow)', { timelineWindow: window.map(note => note.id) }).orderBy('note.id', 'DESC').limit(51)) : [];
		const references = rows.map(note => ({ noteId: note.id, canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.peer!.origin}/notes/${note.id}`, this.peer!.peerOrigin), sortAt: (BigInt(this.ids.parse(note.id).date.getTime()) * 1000n).toString(), normalized: true, generation: 1 }));
		const scanned = window.at(-1);
		const boundary = scanned ? { noteId: scanned.id, canonicalUri: scanned.uri ?? `${this.peer!.origin}/notes/${scanned.id}`, sortAt: (BigInt(this.ids.parse(scanned.id).date.getTime()) * 1000n).toString() } : null;
		await this.authorizeRead(input);
		return { references: references.slice(0, 50), next: references.length > 50 ? references[49] : candidates.length > 512 ? boundary : null, upper: input.timelineUpper ?? (candidates[0] ? { noteId: candidates[0].id, canonicalUri: candidates[0].uri ?? `${this.peer!.origin}/notes/${candidates[0].id}`, sortAt: (BigInt(this.ids.parse(candidates[0].id).date.getTime()) * 1000n).toString() } : null), sequence, generation: status.generation, changed: false };
	}

	private async listQuery(viewerId: string, input: PrivatePeerRequest, boundedSearch = false) {
		const query = this.query(viewerId, input, undefined, false, boundedSearch && !!input.query);
		if ((input.contextMode ?? input.mode) === 'antenna') {
			if (!this.fanout || !input.antennaId) throw new GridspaceLinkError('INVALID_REQUEST');
			const antenna = await this.db.getRepository(MiAntenna).findOneBy({ id: input.antennaId, userId: viewerId });
			if (!antenna) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			await this.db.getRepository(MiAntenna).update(antenna.id, { isActive: true, lastUsedAt: new Date() });
			if (!antenna.isActive) this.events?.publishInternalEvent('antennaUpdated', { ...antenna, isActive: true });
			const ids = await this.fanout.get(`antennaTimeline:${antenna.id}`);
			query.andWhere(ids.length ? 'note.id IN (:...listAntennaIds)' : '1=0', { listAntennaIds: ids });
		}
		return query;
	}

	/** A single origin-ID stream joins independently authorized public/private arms. */
	public async peerListTimeline(input: PrivatePeerRequest) {
		const mode = input.mode === 'validate' ? input.contextMode : input.mode;
		if (!mode || !['profile', 'search', 'mentions', 'direct', 'channel', 'favorites', 'antenna', 'clip'].includes(mode)) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.timelineValidate && (input.ids?.length ?? 0) > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if ((mode === 'channel') !== !!input.channelId || (mode === 'clip') !== !!input.clipId || (mode === 'antenna') !== !!input.antennaId || (mode === 'profile' && !input.targetUris?.length)) throw new GridspaceLinkError('INVALID_REQUEST');
		const initialSequence = await this.timelineReferences.currentPosition();
		const isPublicList = (mode === 'profile' || mode === 'search') && !!input.timelineViewerId;
		const publicInput = { ...input, kind: mode, viewerId: input.timelineViewerId } as PublicListRequest;
		const publicQuery = isPublicList ? await this.publicLists!.buildQuery(publicInput) : null;
		let link: Awaited<ReturnType<GridspacePrivateService['authorizeRead']>> | null = null;
		if (input.accessToken || input.channelActorId || !isPublicList) {
			try { link = await this.authorizeRead(input); } catch (error) {
				if (!isPublicList || !(error instanceof GridspaceLinkError) || !['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code)) throw error;
			}
		}
		if (link?.initiator && input.channelId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const sourceInput = link?.initiator ? { ...input, withChannelNotes: false } : input;
		const privateQuery = link ? await this.listQuery(link.localUserId, sourceInput) : null;
		if (link && input.query && (!input.query.trim() || !(await this.roles.getUserPolicies(link.localUserId)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const reference = (note: MiNote, publicNote = false): Omit<TimelineReference, 'source'> => {
			const sourceId = mode === 'favorites' ? this.collectionId(note) : undefined;
			return { noteId: note.id, ...(sourceId ? { sourceId } : {}), canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.peer!.origin}/notes/${note.id}`, this.peer!.peerOrigin),
				sortAt: (BigInt(this.ids.parse(sourceId ?? note.id).date.getTime()) * 1000n).toString(), normalized: true, generation: 1, ...(publicNote ? { public: true } : {}) };
		};
		const status = await this.timelineReferences.status();
		const changes = input.timelineSequence != null ? await this.timelineReferences.changes(input.timelineSequence, 100) : null;
		const changedIds = [...new Set(changes?.events.flatMap(event => event.noteId ? [event.noteId] : []) ?? [])];
		const readIds = async (ids: string[]) => {
			if (!ids.length) return { rows: [] as MiNote[], publicIds: new Set<string>() };
			const publicRows = publicQuery ? await this.search.read((await this.publicLists!.buildQuery(publicInput, true)).andWhere('note.id IN (:...listPublicIds)', { listPublicIds: ids }).limit(513)) : [];
			const privateRows = privateQuery ? await this.search.read((await this.listQuery(link!.localUserId, sourceInput, true)).andWhere('note.id IN (:...listPrivateIds)', { listPrivateIds: ids }).limit(513)) : [];
			return { rows: [...new Map([...privateRows, ...publicRows].map(note => [note.id, note])).values()], publicIds: new Set(publicRows.map(note => note.id)) };
		};
		if (input.timelineValidate) {
			const started = Date.now();
			const sequence = changes?.cursor ?? initialSequence;
			const eligible = await readIds(input.ids ?? []);
			const privateIds = eligible.rows.filter(note => !eligible.publicIds.has(note.id)).map(note => note.id);
			const packed = link && privateIds.length ? await this.peerNotes({ ...sourceInput, mode: 'validate', contextMode: mode, ids: privateIds }) : { notes: [] as PrivateWireNote[] };
			if (link) await this.authorizeRead(input);
			const fresh = await readIds(input.ids ?? []);
			const freshIds = new Set(fresh.rows.map(note => note.id));
			const refs = fresh.rows.map(note => reference(note, fresh.publicIds.has(note.id)));
			const requested = input.timelineCandidates;
			const retained = requested ? refs.filter(ref => requested.some(candidate => candidate.noteId === ref.noteId && candidate.canonicalUri === ref.canonicalUri && (candidate.sourceId ?? candidate.noteId) === (ref.sourceId ?? ref.noteId))) : refs;
			const allowed = new Set(retained.map(ref => ref.noteId));
			const newer = await readIds(changedIds);
			const policyIds = packed.notes.flatMap(note => [note.id, ...(note.renote ? [note.renote.id] : [])]);
			const policyNotes = link && policyIds.length ? await this.search.read(this.query(link.localUserId, { mode: 'show', channelId: input.channelId }, undefined, true).andWhere('note.id IN (:...listPolicyIds)', { listPolicyIds: policyIds })) : [];
			const policyAllowed = new Set(policyNotes.map(note => note.id));
			packed.notes = packed.notes.filter(note => policyAllowed.has(note.id));
			for (const note of packed.notes) if (note.renote && !policyAllowed.has(note.renote.id)) { delete note.renote; note.renoteId = null; }
			let lease = Math.max(0, TIMELINE_AUTHORIZATION_TTL_MS - (Date.now() - started));
			for (const note of policyNotes) {
				if (note.userId === link!.localUserId) continue;
				for (const [kind, policy] of [['hidden', note.user?.makeNotesHiddenBefore], ['followers', note.user?.makeNotesFollowersOnlyBefore]] as const) {
					if (policy != null && policy <= 0) {
						const cutoff = this.ids.parse(note.id).date.getTime() - policy * 1000;
						const remaining = cutoff - Date.now();
						if (remaining > 0) lease = Math.min(lease, remaining);
						else if (kind === 'hidden' || cutoff > started) lease = 0;
					}
				}
			}
			if (link) await this.authorizeRead(input);
			return { references: retained, notes: packed.notes.filter(note => freshIds.has(note.id) && allowed.has(note.id)), newReferences: newer.rows.filter(note => changes?.events.some(event => event.noteId === note.id && event.kind === 'insert')).map(note => reference(note, newer.publicIds.has(note.id))),
				sequence, generation: status.generation, validForMs: lease,
				changed: changes ? changes.resetRequired || changes.events.some(event => !event.noteId && (!event.affectedUserId || event.affectedUserId === link?.localUserId)) || changes.events.some(event => event.kind !== 'insert' && event.noteId && [...freshIds, ...newer.rows.map(note => note.id), ...(input.ids ?? [])].includes(event.noteId)) || (mode === 'clip' && newer.rows.length > 0) : false };
		}
		const ascending = mode === 'clip' && input.order === 'oldest';
		const column = mode === 'favorites' ? 'collection.id' : 'candidate.id';
		const scan = this.db.getRepository(MiNote).createQueryBuilder('candidate').select(['candidate.id', 'candidate.uri']);
		if (mode === 'channel') scan.andWhere('candidate.channelId = :listChannel', { listChannel: input.channelId });
		if (mode === 'mentions' || mode === 'direct') {
			scan.andWhere('(:listRecipient::varchar[] <@ candidate.mentions OR :listRecipient::varchar[] <@ candidate.visibleUserIds)', { listRecipient: [link!.localUserId] });
			if (mode === 'direct') scan.andWhere('candidate.visibility = \'specified\'');
		}
		// Match the native mentions query: sort recipient-index results instead of
		// walking the primary key through unrelated notes to fill a small window.
		const orderColumn = mode === 'mentions' || mode === 'direct' ? 'CONCAT(candidate.id)' : column;
		let authorIds: string[] | undefined;
		if (input.targetUris?.length) {
			const prefix = `${this.peer!.origin}/users/`;
			const authors = await this.db.getRepository(MiUser).find({ select: { id: true }, where: [
				{ uri: In(input.targetUris) }, { host: IsNull(), id: In(input.targetUris.filter(uri => uri.startsWith(prefix)).map(uri => uri.slice(prefix.length))) },
			] });
			authorIds = authors.map(author => author.id);
		}
		if (mode === 'favorites') scan.innerJoinAndMapOne('candidate.gridspaceCollection', MiNoteFavorite, 'collection', 'collection.noteId = candidate.id AND collection.userId = :listOwner', { listOwner: link!.localUserId });
		if (mode === 'clip') scan.innerJoin(MiClipNote, 'listClip', 'listClip.noteId = candidate.id AND listClip.clipId = :listClip', { listClip: input.clipId });
		if (mode === 'antenna') {
			const ids = await this.fanout!.get(`antennaTimeline:${input.antennaId}`);
			scan.andWhere(ids.length ? 'candidate.id IN (:...listAntenna)' : '1=0', { listAntenna: ids });
		}
		for (const [boundary, parameter, operator] of [[input.timelineBefore, 'listBefore', ascending ? '>' : '<'], [input.timelineUpper, 'listUpper', '<=']] as const) {
			if (boundary) {
				const key = mode === 'favorites' ? boundary.sourceId : boundary.noteId;
				if (!key || !/^[a-zA-Z0-9]{1,32}$/.test(key)) throw new GridspaceLinkError('INVALID_CURSOR');
				scan.andWhere(`${column} ${operator} :${parameter}`, { [parameter]: key });
			}
		}
		if (input.timelineUntilAt != null) scan.andWhere(`${column} < :listUntil`, { listUntil: this.ids.gen(input.timelineUntilAt + 1) });
		if (input.timelineFromAt != null) scan.andWhere(`${column} > :listFrom`, { listFrom: this.ids.gen(Math.max(0, input.timelineFromAt - 1)) });
		if (input.timelineAnchor) {
			const sequence = initialSequence;
			const query = publicQuery ?? privateQuery!;
			const rows = await this.readTimelineAnchor(query, input.timelineAnchor);
			if (link) await this.authorizeRead(input);
			return { references: rows.map(note => reference(note, !!publicQuery)), next: null, upper: null, sequence, generation: status.generation, changed: false };
		}
		const sequence = initialSequence;
		const windowSize = mode === 'search' && !authorIds ? 4096 : 512;
		const candidates = authorIds ? (await Promise.all(authorIds.map(author => this.search.read(scan.clone().andWhere('candidate.userId = :listScanAuthor', { listScanAuthor: author }).orderBy('candidate.id', 'DESC').limit(windowSize + 1)))))
			.flat().sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0).slice(0, windowSize + 1)
			: await this.search.read(scan.orderBy(orderColumn, ascending ? 'ASC' : 'DESC').limit(windowSize + 1));
		const window = candidates.slice(0, windowSize);
		const eligible = await readIds(window.map(note => note.id));
		const byId = new Map(eligible.rows.map(note => [note.id, note]));
		const refs = window.flatMap(note => byId.has(note.id) ? [reference(byId.get(note.id)!, eligible.publicIds.has(note.id))] : []);
		const more = refs.length > 50 || candidates.length > windowSize;
		const bound = refs.length > 50 ? refs[49] : window.at(-1) ? reference(window.at(-1)!) : null;
		const highest = ascending ? (await this.search.read(scan.clone().orderBy(column, 'DESC').limit(1)))[0] : window[0];
		if (link) await this.authorizeRead(input);
		return { references: refs.slice(0, 50), next: more ? bound : null, upper: input.timelineUpper ?? (highest ? reference(highest) : null), sequence, generation: status.generation, changed: false };
	}

	/** No payload is retained between requests; credentials never leave this service. */
	public async timeline(viewer: MiLocalUser, input: Partial<TimelineOptions> & { before?: TimelinePosition; upper?: TimelinePosition; ids?: string[]; candidates?: TimelineReference[]; sequence?: string; anchor?: string; untilAt?: number; fromAt?: number; deadline?: number }) {
		if (!await this.db.getRepository(MiUser).existsBy({ id: viewer.id, host: IsNull(), isSuspended: false, isDeleted: false })) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const mode = !input.kind || input.kind === 'social' ? 'home' : input.kind;
		if ((mode === 'channel') !== !!input.channelId || (mode === 'clip') !== !!input.clipId || (mode === 'antenna') !== !!input.antennaId || (mode === 'profile' && !input.userId)) throw new GridspaceLinkError('INVALID_REQUEST');
		if ((input.query || mode === 'search') && (!input.query?.trim() || !(await this.roles.getUserPolicies(viewer.id)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const channel = this.channelAuth.isClient && (mode === 'home' || mode === 'channel') ? await this.channelAuth.destination(viewer) : null;
		const publicList = mode === 'profile' || mode === 'search';
		let link: Awaited<ReturnType<GridspaceLinkService['privateLink']>> | null = null;
		if (!channel) {
			try { link = await this.links.privateLink(viewer.id); } catch (error) {
				if (!publicList || !(error instanceof GridspaceLinkError) || !['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code)) throw error;
			}
		}
		let credential = channel ? channel.credential : {};
		if (link) {
			try { credential = this.links.privateCredential(link); } catch (error) {
				if (!publicList || !(error instanceof GridspaceLinkError)) throw error;
				link = null;
			}
		}
		const targetUris = input.userId ? await this.targets(input.userId) : undefined;
		const startedAt = Date.now();
		const position = (value: TimelinePosition | undefined) => value ? { sortAt: value.sortAt, canonicalUri: value.canonicalUri, noteId: value.noteId, sourceId: value.sourceId } : undefined;
		let page: { references: Omit<TimelineReference, 'source'>[]; newReferences?: Omit<TimelineReference, 'source'>[]; notes?: PrivateWireNote[]; next?: TimelinePosition | null; upper?: TimelinePosition | null; sequence: string; generation: number; changed: boolean; validForMs?: number };
		try {
			page = await requestGridspacePeer(this.peer!, '/gridspace/v1/private/timeline', {
			...credential, mode: input.ids ? 'validate' : mode, contextMode: input.ids ? mode : undefined, timelineValidate: !!input.ids,
			channelId: input.channelId, query: input.query, clipId: input.clipId, antennaId: input.antennaId, order: input.order, targetUris,
			timelineViewerId: publicList ? viewer.id : undefined,
			timelineCandidates: input.candidates?.map(ref => position(ref)),
			rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt,
			ids: input.ids, timelineBefore: position(input.before), timelineUpper: position(input.upper), timelineSequence: input.sequence,
			timelineAnchor: input.anchor,
			timelineUntilAt: input.untilAt,
			timelineFromAt: input.fromAt,
			withReplies: mode === 'home' || mode === 'profile' ? input.withReplies : undefined, withRenotes: mode === 'home' || mode === 'profile' ? input.withRenotes : undefined, withFiles: mode === 'home' || mode === 'profile' ? input.withFiles : undefined, withChannelNotes: mode === 'profile' ? input.withChannelNotes : undefined,
			timelineIncludeMyRenotes: input.includeMyRenotes, timelineIncludeRenotedMyNotes: input.includeRenotedMyNotes, timelineIncludeLocalRenotes: input.includeLocalRenotes,
			}, 2 * 1024 * 1024, input.deadline ?? Date.now() + 8000) as typeof page;
		} catch (error) { throw new GridspaceLinkError(error instanceof GridspacePeerAuthorizationError ? 'AUTHORIZATION_REVOKED' : 'PEER_UNAVAILABLE'); }
		const validReference = (ref: TimelinePosition) => typeof ref?.noteId === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(ref.noteId) && typeof ref.sortAt === 'string' && /^\d{1,19}$/.test(ref.sortAt) && typeof ref.canonicalUri === 'string' && /^https?:\/\//.test(ref.canonicalUri) && ref.canonicalUri.length <= 1024 && (ref.sourceId == null || /^[a-zA-Z0-9]{1,32}$/.test(ref.sourceId));
		if (!Array.isArray(page.references) || page.references.length > 100 || page.references.some(ref => !validReference(ref)) ||
			(page.newReferences && (page.newReferences.length > 100 || page.newReferences.some(ref => !validReference(ref)))) ||
			(page.next && !validReference(page.next)) || (page.upper && !validReference(page.upper)) ||
			!/^\d+$/.test(page.sequence) || !Number.isInteger(page.generation)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const notes: PrivateNote[] = [];
		const actorAllows = await this.localActorChecker(viewer, this.actorsForNotes(page.notes ?? []));
		for (const note of page.notes ?? []) {
			if (note.origin !== this.peer!.peerOrigin) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			if (await this.localAllows(viewer, note, mode === 'home', channel?.peerUserId ?? link!.peerUserId, actorAllows)) {
				const { filterActors: _actors, ...display } = note;
				notes.push(await this.filterChannelRenote(viewer, display, channel?.peerUserId ?? link!.peerUserId, actorAllows));
			}
		}
		if (channel) await channel.check(); else if (link) await this.links.checkPrivateUnchanged(link);
		return { ...page, references: page.references.map(ref => ({ ...ref, source: 'peer' as const })), newReferences: (page.newReferences ?? []).map(ref => ({ ...ref, source: 'peer' as const })), notes, validForMs: Math.max(0, Math.min(TIMELINE_AUTHORIZATION_TTL_MS, page.validForMs ?? TIMELINE_AUTHORIZATION_TTL_MS) - (Date.now() - startedAt)) };
	}

	private collectionId(note: MiNote) { return (note as MiNote & { gridspaceCollection?: { id: string } }).gridspaceCollection?.id; }

	private actor(user: MiUser) {
		return { name: user.name, username: user.username, host: user.host ?? new URL(this.peer!.origin).host, uri: user.uri ?? `${this.peer!.origin}/users/${user.id}` };
	}

	private async emojiUrls(names: string[], host: string | null) {
		const result = await this.emojis.populateEmojis(names, host);
		const local = await this.emojis.localEmojisCache.fetch();
		for (const name of names) {
			const localName = name.endsWith('@.') ? name.slice(0, -2) : host == null && !name.includes('@') ? name : null;
			const emoji = localName ? local.get(localName) : null;
			if (emoji) result[name] = emoji.publicUrl || emoji.originalUrl;
		}
		// Channel posts may not have passed through the ActivityPub emoji cache.
		return fillPeerEmojiUrls(this.peer, result, names, host);
	}

	private async pack(note: MiNote, viewerId: string, readableRelated: Set<string>, reactionState: Awaited<ReturnType<GridspaceReactionService['show']>>[number] | undefined, authors = new Map<string, Promise<Packed<'UserLite'>>>()): Promise<PrivateWireNote> {
		const files = note.fileIds.length ? await this.db.getRepository(MiDriveFile).findBy({ id: In(note.fileIds) }) : [];
		const poll = note.hasPoll ? await this.db.getRepository(MiPoll).findOneBy({ noteId: note.id }) : null;
		const votes = poll ? await this.db.getRepository(MiPollVote).findBy({ noteId: note.id, userId: viewerId }) : [];
		const emojiUrls = await this.emojiUrls(note.emojis, note.userHost);
		if (!authors.has(note.userId)) authors.set(note.userId, this.users.pack(note.user!, { id: viewerId }, { schema: 'UserLite' }));
		const author = await authors.get(note.userId)!;
		if (!reactionState) throw new GridspaceLinkError('UNAVAILABLE');
		const { reactions, myReaction, myReactions } = reactionState;
		const reactionEmojis = { ...reactionState.reactionEmojis, ...await this.emojiUrls(Object.keys(reactions).map(value => value.replace(/^:|:$/g, '')), note.userHost) };

		const actorIds = [note.userId, note.replyUserId, note.renoteUserId, note.renote?.replyUserId, note.renote?.renoteUserId].filter((id): id is string => !!id);
		const actors = await this.db.getRepository(MiUser).findBy({ id: In(actorIds) });
		return {
			id: note.id, uri: note.uri ?? `${this.peer!.origin}/notes/${note.id}`, origin: this.peer!.origin, createdAt: this.ids.parse(note.id).date.toISOString(), text: note.text, cw: note.cw,
			visibility: note.visibility, localOnly: note.localOnly, noRelay: note.noRelay, emojis: emojiUrls,
			...(this.collectionId(note) ? { collectionId: this.collectionId(note), collectionAt: this.ids.parse(this.collectionId(note)!).date.toISOString() } : {}),
			...(note.multiNoteKind ? { multiNoteKind: note.multiNoteKind, includeDefault: note.includeDefault ?? false, ...(dedicatedOriginal(note) ? { conversationUri: `${this.peer!.origin}/notes/${note.id}` } : {}) } : {}),
			channelId: note.channelId, canDelete: (!!note.channelId || (dedicatedOriginal(note) && note.multiNoteKind === 'conversation-reply')) && note.userId === viewerId,
			canSelfRenote: !this.collectionClient && canSelfRenote(note, viewerId),
			canQuoteOutside: !!note.channel?.allowRenoteToExternal && ['public', 'home'].includes(note.visibility) && !(note.renoteId && !note.text && !note.fileIds.length && !note.hasPoll),
			gridspaceQuote: note.gridspaceQuote ?? undefined,
			channel: note.channel ? { id: note.channel.id, name: note.channel.name, color: note.channel.color, isSensitive: note.channel.isSensitive } : null,
			reactions, reactionEmojis, myReaction, myReactions, extendedReactions: dedicatedOriginal(note) || !!note.channelId || supportsGridspaceReactions(note, this.peer),
			reactionPreviews: reactionState.reactionPreviews?.filter(row => Object.keys(reactions).some(reaction => reaction.replace('@.:', ':') === row.reaction.replace('@.:', ':'))),
			author: { ...this.actor(note.user!), avatarUrl: author.avatarUrl, emojis: await this.emojiUrls(note.user!.emojis, note.user!.host), avatarBlurhash: author.avatarBlurhash, avatarDecorations: author.avatarDecorations, isBot: author.isBot, isCat: author.isCat,
													instance: note.user!.host ? author.instance && { name: author.instance.name, faviconUrl: author.instance.faviconUrl, themeColor: author.instance.themeColor } : { name: this.meta.name, faviconUrl: this.meta.iconUrl, themeColor: this.meta.themeColor } }, filterActors: actors.map(user => this.actor(user)),
			replyId: note.replyId && readableRelated.has(note.replyId) ? note.replyId : null,
			renoteId: note.renoteId && readableRelated.has(note.renoteId) ? note.renoteId : null,
			files: files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size, comment: file.comment, ...(note.multiNoteKind && ['public', 'home'].includes(note.visibility) ? { url: this.driveFiles!.getPublicUrl(file), thumbnailUrl: this.driveFiles!.getThumbnailUrl(file) } : {}), isSensitive: file.isSensitive || file.maybeSensitive })),
			poll: poll ? { choices: poll.choices.map((text, i) => ({ text, votes: poll.votes[i] ?? 0, isVoted: votes.some(vote => vote.choice === i) })), expiresAt: poll.expiresAt?.toISOString() ?? null, multiple: poll.multiple } : null,
		};
	}

	/** No delegated body, attachment URL or search document is persisted. */
	public async peerNotes(input: PrivatePeerRequest): Promise<PrivatePage> {
		if (input.mode !== 'validate' && input.contextMode) throw new GridspaceLinkError('INVALID_REQUEST');
		const observedAt = new Date().toISOString();
		const link = await this.authorizeRead(input);
		if ((input.contextMode ?? input.mode) === 'context' && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (input.channelId && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const sourceInput = link.initiator ? { ...input, withChannelNotes: false } : input;
		if ((input.query || input.mode === 'search' || input.contextMode === 'search') && (!(input.query?.trim()) || !(await this.roles.getUserPolicies(link.localUserId)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const homePage = input.mode === 'home' && !input.targetUris ? await this.sourceHomePage(link.localUserId, sourceInput) : null;
		const rows = homePage ? homePage.rows : await this.sourceNotes(link.localUserId, sourceInput);
		const limit = input.mode === 'validate' ? 100 : input.mode === 'show' ? 1 : input.limit ?? 10;
		const selected = rows.slice(0, limit);
		const homeChannels = !link.initiator && (input.contextMode ?? input.mode) === 'home';
		const relatedIds = selected.flatMap(note => [note.replyId, note.renoteId]).filter((id): id is string => id != null);
		const relatedQuery = () => this.query(link.localUserId, { mode: 'show', channelId: (input.contextMode ?? input.mode) === 'context' && input.contextScope === 'user' ? undefined : input.channelId, withChannelNotes: !link.initiator }, undefined, homeChannels);
		const related = relatedIds.length ? await this.search.read(relatedQuery().andWhere('note.id IN (:...related)', { related: relatedIds })) : [];
		const previewTargets = related.filter(note => selected.some(parent => parent.renoteId === note.id && (
			((input.channelId || homeChannels) && !!note.channelId && parent.channelId === note.channelId) ||
			(!link.initiator && !this.collectionClient && canSelfRenote(note, link.localUserId))
		)));
		const reactionIds = [...new Set([...selected, ...previewTargets].map(note => note.id))];
		const placedIds = selected.filter(note => note.multiNoteKind != null).map(note => note.id);
		const placements = placedIds.length ? await this.notePlacements!.pack(placedIds, { id: link.localUserId }) : null;
		const reactionStates = new Map((reactionIds.length ? await this.extendedReactions.show(reactionIds, { id: link.localUserId }, true) : []).map(state => [state.noteId, state]));
		const authors = new Map<string, Promise<Packed<'UserLite'>>>();
		const packed = await Promise.all(selected.map(note => this.pack(note, link.localUserId, new Set(related.map(item => item.id)), reactionStates.get(note.id), authors)));
		const previews = new Map(await Promise.all(previewTargets.map(async note => [note.id, await this.pack(note, link.localUserId, new Set(), reactionStates.get(note.id), authors)] as const)));
		for (const note of packed) {
			if (!note.multiNoteKind) continue;
			note.channelPlacements = placements?.get(note.id) ?? [];
			if (placements?.unavailableNoteIds?.has(note.id)) note.channelPlacementsUnavailable = true;
		}
		for (const note of packed) if (note.renoteId && previews.has(note.renoteId)) note.renote = previews.get(note.renoteId);
		if (link.initiator) for (const note of [...packed, ...previews.values()]) note.canSelfRenote = false;
		// Recheck after packing attachments/polls, not just before the asynchronous work.
		await this.authorizeRead(input);
		const freshQuery = (input.contextMode ?? input.mode) === 'context' ? await this.contextQuery(link.localUserId, sourceInput) : this.query(link.localUserId, sourceInput);
		const fresh = selected.length ? await this.search.read(freshQuery.andWhere('note.id IN (:...selected)', { selected: selected.map(note => note.id) })) : [];
		const allowed = new Set(fresh.map(note => note.id));
		const freshRelated = relatedIds.length ? await this.search.read(relatedQuery().andWhere('note.id IN (:...related)', { related: relatedIds })) : [];
		const relatedAllowed = new Set(freshRelated.map(note => note.id));
		for (const note of packed) {
			if (note.replyId && !relatedAllowed.has(note.replyId)) note.replyId = null;
			if (note.renoteId && !relatedAllowed.has(note.renoteId)) { note.renoteId = null; delete note.renote; }
		}
		await this.authorizeRead(input);
		return { notes: packed.filter(note => allowed.has(note.id)), next: homePage ? homePage.next : rows.length > limit ? this.collectionId(selected.at(-1)!) ?? selected.at(-1)!.id : null, head: homePage ? homePage.head : input.head ?? (selected[0] ? this.collectionId(selected[0]) ?? selected[0].id : null),
											scannedThrough: homePage ? homePage.scannedThrough : selected.length ? this.ids.parse(this.collectionId(selected.at(-1)!) ?? selected.at(-1)!.id).date.toISOString() : null, observedAt };
	}

	public async localActorAllows(viewer: MiLocalUser, actor: PrivateWireNote['author'] | PrivateWireNote['filterActors'][number]) {
		const profile = await this.db.getRepository(MiUserProfile).findOneBy({ userId: viewer.id });
		if (this.utility.isBlockedHost(this.meta.blockedHosts, actor.host) || profile?.mutedInstances.includes(actor.host)) return false;
		const where = actor.uri.startsWith(`${this.peer!.origin}/users/`) ? { id: actor.uri.slice(`${this.peer!.origin}/users/`.length), host: IsNull() } : { uri: actor.uri };
		const local = await this.db.getRepository(MiUser).findOneBy(where);
		return !local || !!(await this.search.userQuery(viewer).andWhere('user.id = :author', { author: local.id }).getOne());
	}

	/** One current ACL query for a page, never retained across requests. */
	public async localActorChecker(viewer: MiLocalUser, actors: PrivateWireNote['filterActors']) {
		const unique = [...new Map(actors.map(actor => [JSON.stringify([actor.uri, actor.host]), actor])).values()];
		const results = new Map<string, boolean>();
		if (!unique.length) return async () => false;
		const profile = await this.db.getRepository(MiUserProfile).findOneBy({ userId: viewer.id });
		const permittedHosts = unique.filter(actor => !this.utility.isBlockedHost(this.meta.blockedHosts, actor.host) && !profile?.mutedInstances.includes(actor.host));
		const prefix = `${this.peer!.origin}/users/`;
		const uris = permittedHosts.filter(actor => !actor.uri.startsWith(prefix)).map(actor => actor.uri);
		const ids = permittedHosts.filter(actor => actor.uri.startsWith(prefix)).map(actor => actor.uri.slice(prefix.length));
		const users = uris.length || ids.length ? await this.db.getRepository(MiUser).find({ select: { id: true, uri: true, host: true }, where: [
			...(uris.length ? [{ uri: In(uris) }] : []), ...(ids.length ? [{ id: In(ids), host: IsNull() }] : []),
		] }) : [];
		const byUri = new Map(users.flatMap(user => [
			...(user.uri ? [[user.uri, user.id] as const] : []),
			...(user.host == null ? [[`${prefix}${user.id}`, user.id] as const] : []),
		]));
		const allowed = new Set(users.length ? (await this.search.userQuery(viewer).andWhere('user.id IN (:...actorIds)', { actorIds: users.map(user => user.id) }).select('user.id').getMany()).map(user => user.id) : []);
		for (const actor of permittedHosts) {
			const localId = byUri.get(actor.uri);
			results.set(JSON.stringify([actor.uri, actor.host]), localId == null || allowed.has(localId));
		}
		return async (actor: PrivateWireNote['filterActors'][number]) => results.get(JSON.stringify([actor.uri, actor.host])) ?? false;
	}

	public actorsForNotes(notes: PrivateWireNote[]): PrivateWireNote['filterActors'] {
		if (notes.some(note => !Array.isArray(note.filterActors) || (note.renote && !Array.isArray(note.renote.filterActors)))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		return notes.flatMap(note => [...note.filterActors, ...(note.renote?.filterActors ?? [])]);
	}

	public async localAllows(viewer: MiLocalUser, note: PrivateWireNote, home: boolean, peerUserId: string,
		actorAllows: (actor: PrivateWireNote['filterActors'][number]) => Promise<boolean> = actor => this.localActorAllows(viewer, actor)) {
		for (const actor of note.filterActors) if (!await actorAllows(actor)) return false;
		if (!home) return true;
		// The source rechecks channel subscriptions and mutes on every home page
		// and validation pass. Do not require a separate follow of its author.
		if (note.channelId) return this.collectionClient;
		const uri = note.author.uri;
		const where = uri.startsWith(`${this.peer!.origin}/users/`) ? { id: uri.slice(`${this.peer!.origin}/users/`.length), host: IsNull() } : { uri };
		const local = await this.db.getRepository(MiUser).findOneBy(where);
		if (home && uri !== `${this.peer!.peerOrigin}/users/${peerUserId}` && local?.id !== viewer.id) {
			if (!local) return false;
			const subscription = { followerId: viewer.id, followeeId: local.id };
			if (!(await this.db.getRepository(MiFollowing).existsBy(subscription)) && !(await this.db.getRepository(MiFollowRequest).existsBy(subscription))) return false;
		}
		return true;
	}

	/** Shared by timeline reads and the updated note returned after an action. */
	public async filterChannelRenote(viewer: MiLocalUser, note: PrivateNote, peerUserId: string,
		actorAllows?: (actor: PrivateWireNote['filterActors'][number]) => Promise<boolean>): Promise<PrivateNote> {
		const { renote: preview, ...body } = note;
		if (!preview) return body;
		const wire = preview as PrivateWireNote;
		if (!Array.isArray(wire.filterActors)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		if (!await this.localAllows(viewer, wire, false, peerUserId, actorAllows)) return body;
		const { filterActors: _actors, renote: _nested, ...flat } = wire;
		return { ...body, renote: flat };
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
		if (input.mode !== 'validate' && input.contextMode) throw new GridspaceLinkError('INVALID_REQUEST');
		const channel = input.conversationUri ? await this.placementActions!.destination(viewer, input.conversationUri, input.noteId) :
			input.channelId || (this.channelAuth.isClient && (input.contextMode ?? input.mode) === 'home') ? await this.channelAuth.destination(viewer) : null;
		const link = channel ? null : await this.links.privateLink(viewer.id);
		const credential = channel ? channel.credential : this.links.privateCredential(link!);
		if ((input.query || input.mode === 'search' || input.contextMode === 'search') && (!input.query?.trim() || !(await this.roles.getUserPolicies(viewer.id)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if ((input.mode === 'profile' && !input.userId) || (input.mode === 'show' && !input.noteId) || (input.mode === 'validate' && !input.ids?.length)) throw new GridspaceLinkError('INVALID_REQUEST');
		const options: PrivateOptions = {
			mode: input.mode, contextMode: input.contextMode, contextScope: input.contextScope, conversationUri: input.conversationUri, order: input.order ?? (input.conversationUri && input.mode === 'context' ? 'oldest' : undefined), query: input.query?.trim(), userId: input.userId, noteId: input.noteId, channelId: input.channelId, clipId: input.clipId, antennaId: input.antennaId,
			ids: input.ids, rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt,
			withReplies: input.withReplies ?? true, withRenotes: input.withRenotes ?? true, withFiles: input.withFiles ?? false, withChannelNotes: input.withChannelNotes ?? true,
		};
		const targetUris = input.userId ? await this.targets(input.userId) : undefined;
		const context = `private:${viewer.id}:${channel?.key ?? `${link!.id}:${link!.generation}:${gridspaceHash(link!.privateTokenCipher!)}`}:${JSON.stringify({ options, targetUris })}`;
		let state;
		try { state = cursor ? decodeHistoryCursor(this.peer!, cursor, context) : { local: null, remote: null, localHead: null, remoteHead: null, expires: Date.now() + 3600_000 }; } catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
		const { userId: _userId, ...peerOptions } = options;
		const page = await this.links.json<PrivatePage>('/gridspace/v1/private/notes', {
			...credential, ...peerOptions, targetUris, before: state.remote ?? undefined, head: state.remoteHead ?? undefined, limit,
		});
		if (!Array.isArray(page.notes) || page.notes.length > (input.mode === 'validate' ? 100 : limit) || page.notes.some(note => note.origin !== this.peer!.peerOrigin)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		if (!Number.isFinite(Date.parse(page.observedAt)) || (page.next && !Number.isFinite(Date.parse(page.scannedThrough ?? '')))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const notes: PrivateNote[] = [];
		const actorAllows = await this.localActorChecker(viewer, this.actorsForNotes(page.notes));
		for (const note of page.notes) if (await this.localAllows(viewer, note, (input.contextMode ?? input.mode) === 'home', channel?.peerUserId ?? link!.peerUserId, actorAllows)) {
			const { filterActors: _filterActors, ...display } = note;
			notes.push(await this.filterChannelRenote(viewer, display, channel?.peerUserId ?? link!.peerUserId, actorAllows));
		}
		if (channel) await channel.check(); else await this.links.checkPrivateUnchanged(link!);
		const next = page.next ? encodeHistoryCursor(this.peer!, { ...state, remote: page.next, remoteHead: page.head }, context) : null;
		return { notes, cursor: next, scannedThrough: page.scannedThrough, observedAt: page.observedAt };
	}

	public async peerCollections(input: PrivatePeerRequest) {
		const link = await this.links.authorizePrivate(input);
		if (link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const favorites = await this.links.hasCollectionScope(input, 'favorites');
		const clips = await this.links.hasCollectionScope(input, 'clips');
		const clipFavorites = await this.links.hasCollectionScope(input, 'clip-favorites');
		if (input.collectionKind === 'status') return { favorites, clips, clipFavorites, clipsList: [], next: null, scannedThrough: null, origin: this.peer!.origin };
		if (!clips || (input.collectionKind === 'clip-favorites' && !clipFavorites)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const query = this.db.getRepository(MiClip).createQueryBuilder('clip')
			.where('(clip.isPublic = true OR clip.userId = :viewer)', { viewer: link.localUserId });
		if (input.clipId) query.andWhere('clip.id = :clipId', { clipId: input.clipId });
		else if (input.collectionKind === 'clip-favorites') query.innerJoin(MiClipFavorite, 'favorite', 'favorite.clipId = clip.id AND favorite.userId = :viewer');
		else query.andWhere('clip.userId = :viewer');
		if (input.ids?.length) query.andWhere('clip.id IN (:...collectionIds)', { collectionIds: input.ids });
		if (input.before) query.andWhere('clip.id < :before', { before: input.before });
		const limit = input.clipId ? 1 : input.limit ?? 10;
		const rows = await query.orderBy('clip.id', 'DESC').take(limit + 1).getMany();
		const selected = rows.slice(0, limit);
		const packed = await this.clips.packMany(selected, { id: link.localUserId });
		const fresh = selected.length ? await query.clone().andWhere('clip.id IN (:...ids)', { ids: selected.map(c => c.id) }).getMany() : [];
		await this.links.authorizePrivate(input);
		if (!await this.links.hasCollectionScope(input, input.collectionKind === 'clip-favorites' ? 'clip-favorites' : 'clips')) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return { favorites, clips, clipFavorites, clipsList: packed.filter(c => fresh.some(f => f.id === c.id)).map(c => ({ ...c, user: { ...c.user, host: c.user.host ?? new URL(this.peer!.origin).host } })), next: rows.length > limit ? selected.at(-1)!.id : null, scannedThrough: selected.length ? this.ids.parse(selected.at(-1)!.id).date.toISOString() : null, origin: this.peer!.origin };
	}

	public async collections(viewer: MiLocalUser, kind: 'status' | 'clips' | 'clip-favorites', clipId?: string, before?: string, limit = 10, ids?: string[]) {
		const disabled = { enabled: false, favorites: false, clips: false, clipFavorites: false, clipsList: [], next: null, scannedThrough: null, origin: this.peer?.peerOrigin ?? null };
		if (!this.collectionClient) { if (kind === 'status') return disabled; throw new GridspaceLinkError('AUTHORIZATION_REVOKED'); }
		const link = await this.links.privateLink(viewer.id).catch(error => { if (kind === 'status' && error instanceof GridspaceLinkError && error.code === 'LINK_REVOKED') return null; throw error; });
		if (!link) return disabled;
		if (!link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const page = await this.links.json<Awaited<ReturnType<GridspacePrivateService['peerCollections']>>>('/gridspace/v1/private/collections', { ...this.links.privateCredential(link), collectionKind: kind, clipId, before, limit, ids });
		if (page.origin !== this.peer!.peerOrigin || !Array.isArray(page.clipsList) || page.clipsList.length > limit) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		await this.links.checkPrivateUnchanged(link);
		return { enabled: true, ...page };
	}

	public async peerFile(input: PrivatePeerRequest) {
		const link = await this.authorizeRead(input);
		if (input.channelId && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const note = (await this.sourceNotes(link.localUserId, { ...input, mode: 'show' }))[0];
		if (!note || (link.initiator && note.channelId) || !input.fileId || !note.fileIds.includes(input.fileId)) throw new GridspaceLinkError('UNAVAILABLE');
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
		await this.authorizeRead(input);
		const fresh = (await this.sourceNotes(link.localUserId, { ...input, mode: 'show' }))[0];
		if (!fresh?.fileIds.includes(file.id) || !await this.db.getRepository(MiDriveFile).existsBy({ id: file.id })) throw new GridspaceLinkError('UNAVAILABLE');
		await this.authorizeRead(input);
		return { data: data.toString('base64'), type: file.type };
	}

	public async file(viewer: MiLocalUser, noteId: string, fileId: string, channelId?: string) {
		const channel = channelId ? await this.channelAuth.destination(viewer) : null;
		const link = channel ? null : await this.links.privateLink(viewer.id);
		const page = await this.notes(viewer, { mode: 'show', noteId, channelId }, 1);
		const note = page.notes[0];
		if (!note?.files.some(file => file.id === fileId)) throw new GridspaceLinkError('UNAVAILABLE');
		const result = await this.links.json<{ data: string; type: string }>('/gridspace/v1/private/file', { ...(channel ? channel.credential : this.links.privateCredential(link!)), mode: 'show', noteId, fileId, channelId }, true, PRIVATE_FILE_LIMIT * 1.4);
		if (channel) await channel.check(); else await this.links.checkPrivateUnchanged(link!);
		if (!(await this.notes(viewer, { mode: 'show', noteId, channelId }, 1)).notes.some(current => current.id === noteId && current.files.some(file => file.id === fileId))) throw new GridspaceLinkError('UNAVAILABLE');
		return result;
	}
}
