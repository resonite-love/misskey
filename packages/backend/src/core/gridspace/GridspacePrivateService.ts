/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, type QueryRunner } from 'typeorm';
import { DI } from '@/di-symbols.js';
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
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceReactionService } from './GridspaceReactionService.js';
import { supportsGridspaceReactions } from './reaction-protocol.js';
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
		private fanout?: FanoutTimelineService,
		private events?: GlobalEventService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.noteTime = searchNoteTimeSql(config.id);
		this.collectionClient = config.gridspace?.channelRole === 'client';
	}

	private async authorizeRead(input: PrivatePeerRequest) {
		if (input.channelId) this.channelAuth.assertSource();
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
		if (!input.channelId || (mode !== 'channel' && mode !== 'show')) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return { localUserId: (await this.channelAuth.source(input.channelActorId)).id, initiator: false };
	}

	private query(viewerId: string, input: Partial<PrivatePeerRequest> = {}, authors?: Pick<MiUser, 'id' | 'makeNotesFollowersOnlyBefore'>[]) {
		const mode = input.mode === 'validate' ? input.contextMode : input.mode;
		if ((mode === 'channel' && !input.channelId) || (input.channelId && mode !== 'channel' && mode !== 'show')) throw new GridspaceLinkError('INVALID_REQUEST');
		if ((mode === 'clip' && !input.clipId) || (input.clipId && mode !== 'clip')) throw new GridspaceLinkError('INVALID_REQUEST');
		if ((mode === 'antenna' && !input.antennaId) || (input.antennaId && mode !== 'antenna')) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = this.search.noteQuery({ id: viewerId }, { query: input.query ?? '', rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt }, false, true, input.channelId, !!input.targetUris?.length, mode === 'mentions' || mode === 'direct' || mode === 'favorites' || mode === 'clip' || mode === 'antenna');
		if (mode === 'favorites') {
			query.innerJoinAndMapOne('note.gridspaceCollection', MiNoteFavorite, 'collection', 'collection.noteId = note.id AND collection.userId = :collectionViewer', { collectionViewer: viewerId });
			query.orderBy('collection.id', 'DESC');
		} else if (mode === 'clip') {
			query.innerJoin(MiClipNote, 'collection', 'collection.noteId = note.id AND collection.clipId = :collectionClip', { collectionClip: input.clipId });
			query.innerJoin(MiClip, 'collectionOwner', 'collectionOwner.id = collection.clipId AND (collectionOwner.userId = :collectionViewer OR collectionOwner.isPublic = true)', { collectionViewer: viewerId });
			query.orderBy('note.id', 'DESC');
		} else if (mode === 'mentions' || mode === 'direct') {
			// Include public mentions too: delivery to the old account does not
			// imply delivery to the new one. Keep the visibility query above.
			query.andWhere('(:mentionViewer::varchar[] <@ note.mentions OR :mentionViewer::varchar[] <@ note.visibleUserIds)', { mentionViewer: [viewerId] });
			if (mode === 'direct') query.andWhere("note.visibility = 'specified'");
			this.queries.generateMutedNoteThreadQuery(query, { id: viewerId });
			// As in notes/mentions, avoid a primary-key scan over the whole timeline.
			query.orderBy('CONCAT(note.id)', 'DESC');
		} else if (mode && mode !== 'show' && mode !== 'channel' && mode !== 'antenna' && authors?.every(author => author.makeNotesFollowersOnlyBefore == null)) {
			query.andWhere("note.visibility IN ('followers', 'specified')");
		} else if (mode && mode !== 'show' && mode !== 'channel' && mode !== 'antenna') {
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
		if (input.withRenotes === false) query.andWhere(mode === 'home' ? '(note.renoteId IS NULL OR note.text IS NOT NULL OR note.cw IS NOT NULL OR note.replyId IS NOT NULL OR cardinality(note.fileIds) > 0 OR note.hasPoll)' : 'note.renoteId IS NULL');
		if (input.withFiles) query.andWhere('cardinality(note.fileIds) > 0');
		if (input.withChannelNotes === false) query.andWhere('note.channelId IS NULL');
		return query;
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
		const query = this.query(viewerId, input, authors);
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
		if (input.before) query.andWhere(`${order}.id < :before`, { before: input.before });
		if (input.head) query.andWhere(`${order}.id <= :head`, { head: input.head });
		const limit = input.mode === 'validate' ? 100 : input.mode === 'show' ? 1 : (input.limit ?? 10) + 1;
		return authors && input.mode !== 'validate' && input.mode !== 'show'
			? this.search.readAuthorPage(query, authors.map(author => author.id), limit)
			: this.search.read(query.take(limit));
	}

	public async readableSourceNote(viewerId: string, noteId: string, runner?: QueryRunner, channelId?: string) {
		const query = this.query(viewerId, { mode: 'show', channelId }).andWhere('note.id = :noteId', { noteId });
		if (runner) return query.setQueryRunner(runner).getOne();
		return (await this.search.read(query))[0] ?? null;
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
		return result;
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
			visibility: note.visibility, localOnly: note.localOnly, emojis: emojiUrls,
			...(this.collectionId(note) ? { collectionId: this.collectionId(note), collectionAt: this.ids.parse(this.collectionId(note)!).date.toISOString() } : {}),
			channelId: note.channelId, canDelete: !!note.channelId && note.userId === viewerId,
			reactions, reactionEmojis, myReaction, myReactions, extendedReactions: !!note.channelId || supportsGridspaceReactions(note, this.peer),
			reactionPreviews: reactionState.reactionPreviews?.filter(row => Object.keys(reactions).some(reaction => reaction.replace('@.:', ':') === row.reaction.replace('@.:', ':'))),
			author: { ...this.actor(note.user!), avatarUrl: author.avatarUrl, emojis: await this.emojiUrls(note.user!.emojis, note.user!.host), avatarBlurhash: author.avatarBlurhash, avatarDecorations: author.avatarDecorations, isBot: author.isBot, isCat: author.isCat,
				instance: note.user!.host ? author.instance && { name: author.instance.name, faviconUrl: author.instance.faviconUrl, themeColor: author.instance.themeColor } : { name: this.meta.name, faviconUrl: this.meta.iconUrl, themeColor: this.meta.themeColor } }, filterActors: actors.map(user => this.actor(user)),
			replyId: note.replyId && readableRelated.has(note.replyId) ? note.replyId : null,
			renoteId: note.renoteId && readableRelated.has(note.renoteId) ? note.renoteId : null,
			files: files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size, comment: file.comment, isSensitive: file.isSensitive || file.maybeSensitive })),
			poll: poll ? { choices: poll.choices.map((text, i) => ({ text, votes: poll.votes[i] ?? 0, isVoted: votes.some(vote => vote.choice === i) })), expiresAt: poll.expiresAt?.toISOString() ?? null, multiple: poll.multiple } : null,
		};
	}

	/** No delegated body, attachment URL or search document is persisted. */
	public async peerNotes(input: PrivatePeerRequest): Promise<PrivatePage> {
		const observedAt = new Date().toISOString();
		const link = await this.authorizeRead(input);
		if (input.channelId && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const sourceInput = link.initiator ? { ...input, withChannelNotes: false } : input;
		if ((input.query || input.mode === 'search' || input.contextMode === 'search') && (!(input.query?.trim()) || !(await this.roles.getUserPolicies(link.localUserId)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const rows = await this.sourceNotes(link.localUserId, sourceInput);
		const limit = input.mode === 'validate' ? 100 : input.mode === 'show' ? 1 : input.limit ?? 10;
		const selected = rows.slice(0, limit);
		const relatedIds = selected.flatMap(note => [note.replyId, note.renoteId]).filter((id): id is string => id != null);
		const related = relatedIds.length ? await this.search.read(this.query(link.localUserId, { mode: 'show', channelId: input.channelId, withChannelNotes: !link.initiator }).andWhere('note.id IN (:...related)', { related: relatedIds })) : [];
		const reactionStates = new Map((selected.length ? await this.extendedReactions.show(selected.map(note => note.id), { id: link.localUserId }, true) : []).map(state => [state.noteId, state]));
		const authors = new Map<string, Promise<Packed<'UserLite'>>>();
		const packed = await Promise.all(selected.map(note => this.pack(note, link.localUserId, new Set(related.map(item => item.id)), reactionStates.get(note.id), authors)));
		// Recheck after packing attachments/polls, not just before the asynchronous work.
		await this.authorizeRead(input);
		const fresh = selected.length ? await this.search.read(this.query(link.localUserId, sourceInput).andWhere('note.id IN (:...selected)', { selected: selected.map(note => note.id) })) : [];
		const allowed = new Set(fresh.map(note => note.id));
		const freshRelated = relatedIds.length ? await this.search.read(this.query(link.localUserId, { mode: 'show', channelId: input.channelId, withChannelNotes: !link.initiator }).andWhere('note.id IN (:...related)', { related: relatedIds })) : [];
		const relatedAllowed = new Set(freshRelated.map(note => note.id));
		for (const note of packed) {
			if (note.replyId && !relatedAllowed.has(note.replyId)) note.replyId = null;
			if (note.renoteId && !relatedAllowed.has(note.renoteId)) note.renoteId = null;
		}
		await this.authorizeRead(input);
		return { notes: packed.filter(note => allowed.has(note.id)), next: rows.length > limit ? this.collectionId(selected.at(-1)!) ?? selected.at(-1)!.id : null, head: input.head ?? (selected[0] ? this.collectionId(selected[0]) ?? selected[0].id : null),
			scannedThrough: selected.length ? this.ids.parse(this.collectionId(selected.at(-1)!) ?? selected.at(-1)!.id).date.toISOString() : null, observedAt };
	}

	public async localActorAllows(viewer: MiLocalUser, actor: PrivateWireNote['author'] | PrivateWireNote['filterActors'][number]) {
		const profile = await this.db.getRepository(MiUserProfile).findOneBy({ userId: viewer.id });
		if (this.utility.isBlockedHost(this.meta.blockedHosts, actor.host) || profile?.mutedInstances.includes(actor.host)) return false;
		const where = actor.uri.startsWith(`${this.peer!.origin}/users/`) ? { id: actor.uri.slice(`${this.peer!.origin}/users/`.length), host: IsNull() } : { uri: actor.uri };
		const local = await this.db.getRepository(MiUser).findOneBy(where);
		return !local || !!(await this.search.userQuery(viewer).andWhere('user.id = :author', { author: local.id }).getOne());
	}

	public async localAllows(viewer: MiLocalUser, note: PrivateWireNote, home: boolean, peerUserId: string,
		actorAllows: (actor: PrivateWireNote['filterActors'][number]) => Promise<boolean> = actor => this.localActorAllows(viewer, actor)) {
		for (const actor of note.filterActors) if (!await actorAllows(actor)) return false;
		if (!home) return true;
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

	private async targets(userId: string) {
		const user = await this.db.getRepository(MiUser).findOneBy({ id: userId });
		if (!user) throw new GridspaceLinkError('UNAVAILABLE');
		const targets = [user.uri ?? `${this.peer!.origin}/users/${user.id}`];
		const link = await this.history.findLink(userId);
		if (link) targets.push(`${this.peer!.peerOrigin}/users/${link.peerUserId}`, `${this.peer!.origin}/users/${link.localUserId}`);
		return [...new Set(targets)];
	}

	public async notes(viewer: MiLocalUser, input: PrivateOptions, limit: number, cursor?: string) {
		const channel = input.channelId ? await this.channelAuth.destination(viewer) : null;
		const link = channel ? null : await this.links.privateLink(viewer.id);
		const credential = channel ? channel.credential : this.links.privateCredential(link!);
		if ((input.query || input.mode === 'search' || input.contextMode === 'search') && (!input.query?.trim() || !(await this.roles.getUserPolicies(viewer.id)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if ((input.mode === 'profile' && !input.userId) || (input.mode === 'show' && !input.noteId) || (input.mode === 'validate' && !input.ids?.length)) throw new GridspaceLinkError('INVALID_REQUEST');
		const options: PrivateOptions = {
			mode: input.mode, contextMode: input.contextMode, query: input.query?.trim(), userId: input.userId, noteId: input.noteId, channelId: input.channelId, clipId: input.clipId, antennaId: input.antennaId,
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
		for (const note of page.notes) if (await this.localAllows(viewer, note, (input.contextMode ?? input.mode) === 'home', channel?.peerUserId ?? link!.peerUserId)) {
			const { filterActors: _filterActors, ...display } = note;
			notes.push(display);
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
