/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { NotePlacementService, type PackedChannelPlacement } from '@/core/NotePlacementService.js';
import { RoleService } from '@/core/RoleService.js';
import { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspaceChannelAuthService } from '../GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService, type GridspacePeerLinkRequest } from '../GridspaceLinkService.js';
import { GridspaceSearchService } from '../GridspaceSearchService.js';
import { GridspaceNoteService } from '../GridspaceNoteService.js';
import { GridspacePlacementService } from '../GridspacePlacementService.js';
import { GridspacePrivateService } from '../GridspacePrivateService.js';
import { canonicalGridspaceNoteUri, gridspaceNoteId, gridspaceNoteUris } from '../note-protocol.js';
import { requestGridspacePeer } from '../peer-client.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from '../peer-protocol.js';
import { searchNoteTimeSql } from '../search-visibility.js';
import { TimelineLocalSource } from './TimelineLocalSource.js';
import { TimelineReferenceService, validTimelinePosition } from './TimelineReferenceService.js';
import { activeChannelEntries } from './placement-change.js';
import { TIMELINE_AUTHORIZATION_TTL_MS, type TimelineItem, type TimelineOptions, type TimelinePosition, type TimelineReference } from './timeline-protocol.js';
import type { DataSource } from 'typeorm';

type Position = Pick<TimelinePosition, 'sortAt' | 'canonicalUri' | 'pinRank'>;
export type PlacementTimelineRequest = { channelId?: string; replyChannelOrigin?: string; includeReplies?: boolean; followed?: boolean; untilAt?: number; after?: string; actorId?: string; followedLink?: Pick<GridspacePeerLinkRequest, 'linkId' | 'generation' | 'localUserId' | 'pairId' | 'accessToken'>; pinnedOnly?: boolean; before?: Position; upper?: Position; uris?: string[]; limit?: number };
type PlacementPage = { references: TimelineReference[]; next: Position | null; upper: Position | null; sequence: string; changed?: boolean };
const uri = { type: 'string', pattern: '^https?://', maxLength: 1024 } as const;
const position = { type: 'object', additionalProperties: false,
																			properties: { pinRank: { type: 'integer', minimum: 0, maximum: 2147483647 }, sortAt: { type: 'string', pattern: '^[0-9]{1,19}$' }, canonicalUri: uri }, required: ['sortAt', 'canonicalUri'] } as const;
export const placementTimelineRequestSchema = { type: 'object', additionalProperties: false, properties: {
	untilAt: { type: 'integer', minimum: 0, maximum: 4102444800000 }, after: { type: 'string', pattern: '^[0-9]{1,19}$' }, followed: { type: 'boolean' }, actorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	followedLink: { type: 'object', additionalProperties: false, required: ['accessToken', 'linkId', 'localUserId', 'generation'], properties: {
		accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
		localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, generation: { type: 'integer', minimum: 1, maximum: 2147483647 },
	} },
	replyChannelOrigin: uri, includeReplies: { type: 'boolean' }, channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, before: position, upper: position,
	pinnedOnly: { type: 'boolean' }, uris: { type: 'array', maxItems: 100, items: uri }, limit: { type: 'integer', minimum: 1, maximum: 100 },
}, required: ['actorId'] } as const;

export function comparePlacementPosition(a: Position, b: Position): number {
	if (a.pinRank !== undefined && b.pinRank !== undefined) return a.pinRank - b.pinRank || Buffer.compare(Buffer.from(b.canonicalUri), Buffer.from(a.canonicalUri));
	const t = BigInt(b.sortAt) - BigInt(a.sortAt);
	return t === 0n ? Buffer.compare(Buffer.from(b.canonicalUri), Buffer.from(a.canonicalUri)) : t > 0n ? 1 : -1;
}

type PlacementBody = Pick<TimelineItem, 'representation' | 'payload' | 'readOnly' | 'validForMs' | 'nextPolicyCheckAt'>;

@Injectable()
export class TimelinePlacementSource {
	private peer: GridspacePeerConfig | null;
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.db) private db: DataSource,
		private local: TimelineLocalSource,
		private shared: GridspaceNoteService,
		private delegated: GridspacePrivateService,
		private changes: TimelineReferenceService,
		private placementService: GridspacePlacementService,
		private roles: RoleService,
		private channelAuth: GridspaceChannelAuthService,
		private links: GridspaceLinkService,
		private notePlacements: NotePlacementService,
		private search: GridspaceSearchService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	/** The index server returns locators only. A listing is never authority to reveal a body. */
	public async peerPage(input: PlacementTimelineRequest): Promise<PlacementPage> {
		if (!this.peer || !input.actorId || !this.config.gridspace?.timelineEnabled) throw new GridspaceLinkError('UNAVAILABLE');
		const actor = await this.placementService.resolveActor(input.actorId);
		if (!input.followedLink) return this.readIndex(input, actor.id, true, Date.now() + 8000);
		if (input.replyChannelOrigin || input.includeReplies) throw new GridspaceLinkError('INVALID_REQUEST');
		const grant = input.followedLink;
		if (!input.followed || input.channelId || grant.localUserId !== input.actorId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		this.channelAuth.assertSource();
		const authorize = async () => {
			const link = await this.links.authorizePrivate(grant);
			if (link.initiator || link.peerUserId !== input.actorId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return link.localUserId;
		};
		const linkedId = await authorize();
		const page = await this.query(input, actor.id, true, linkedId);
		if (await authorize() !== linkedId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return page;
	}

	public supportHome(): Promise<boolean> { return this.placementService.hasPeerCapability(); }

	public async followsAny(viewerId: string, channelIds: string[], linkedId?: string): Promise<boolean> {
		if (!channelIds.length) return false;
		const rows = await this.db.query(`SELECT 1 FROM channel_following f JOIN channel c ON c.id = f."followeeId"
			WHERE f."followerId" = ANY($1::varchar[]) AND f."followeeId" = ANY($2::varchar[])
			AND NOT EXISTS (SELECT 1 FROM blocking b WHERE
				(b."blockerId" = c."userId" AND b."blockeeId" = ANY($1::varchar[])) OR (b."blockerId" = ANY($1::varchar[]) AND b."blockeeId" = c."userId"))
			AND NOT EXISTS (SELECT 1 FROM channel_muting cm WHERE cm."userId" = ANY($1::varchar[]) AND cm."channelId" = f."followeeId"
				AND (cm."expiresAt" IS NULL OR cm."expiresAt" > CURRENT_TIMESTAMP)) LIMIT 1`, [linkedId ? [viewerId, linkedId] : [viewerId], channelIds]);
		return rows.length > 0;
	}

	/** Candidate children live with the original, including when their channel belongs to the peer. */
	private async replyPage(input: PlacementTimelineRequest, viewerId: string, deadline: number): Promise<Pick<PlacementPage, 'references' | 'next'>> {
		const channelOrigin = input.replyChannelOrigin ?? this.peer!.origin;
		const opposite = channelOrigin !== this.peer!.origin;
		const limit = input.limit ?? 50;
		if (!gridspaceNoteId(input.channelId) || limit < 1 || limit > 100 || !Number.isInteger(limit) ||
			(input.uris?.length ?? 0) > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.uris?.length === 0) return { references: [], next: null };
		const result: TimelineReference[] = [];
		let before = input.before;
		while (result.length <= limit) {
			if (Date.now() >= deadline) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			const params: unknown[] = [input.channelId, this.peer!.origin];
			const conditions: string[] = [];
			const table = opposite ? 'gridspace_placement_target' : 'note_channel_placement';
			if (opposite) {
				params.push(channelOrigin);
				conditions.push('route."peerOrigin" = $3');
			}
			for (const [op, value] of [['<', before], ['<=', input.upper]] as const) {
				if (!value) continue;
				if (!validTimelinePosition(value)) throw new GridspaceLinkError('INVALID_CURSOR');
				params.push(value.sortAt, value.canonicalUri);
				conditions.push(`(t.us, ($2 || '/notes/' || note.id) COLLATE "C") ${op} ($${params.length - 1}::bigint, $${params.length} COLLATE "C")`);
			}
			if (input.untilAt !== undefined) {
				params.push(input.untilAt);
				conditions.push(`t.us < ($${params.length}::bigint + 1) * 1000`);
			}
			if (input.uris) {
				params.push(input.uris.flatMap(uri => {
					const prefix = this.peer!.origin + '/notes/';
					return uri.startsWith(prefix) && gridspaceNoteId(uri.slice(prefix.length)) ? [uri.slice(prefix.length)] : [];
				}));
				conditions.push(`note.id = ANY($${params.length}::varchar[])`);
			}
			const rows = await this.db.query<{ id: string; rootId: string; sortAt: string; canonicalUri: string }[]>(
				`SELECT note.id, root.id AS "rootId", t.us::text AS "sortAt", ($2 || '/notes/' || note.id) COLLATE "C" AS "canonicalUri"
				FROM ${table} route JOIN note root ON root.id = route."noteId"
				JOIN note ON note."threadId" = root.id AND note."multiNoteRootId" = root.id
				CROSS JOIN LATERAL (SELECT (${searchNoteTimeSql(this.config.id)}) * 1000 AS us) t
				WHERE route."channelId" = $1 AND route.state = 'active' AND root."multiNoteKind" = 'root'
					AND root."includeDefault" IS FALSE AND root.uri IS NULL AND note."multiNoteKind" = 'conversation-reply'
					AND note.uri IS NULL AND note."includeDefault" IS FALSE ${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
				ORDER BY t.us DESC, "canonicalUri" DESC LIMIT 100`, params);
			if (rows.length) {
				const roots = [...new Set(rows.map(row => row.rootId))];
				const ids = [...new Set([...roots, ...rows.map(row => row.id)])];
				const allowed = await this.search.noteQuery({ id: viewerId }, { query: '' }, false, true, undefined, false, true)
					.select('note.id', 'id').andWhere('note.id IN (:...ids)', { ids }).getRawMany<{ id: string }>();
				const readable = new Set(allowed.map(row => row.id));
				const chips = await this.notePlacements.pack(roots.filter(id => readable.has(id)), { id: viewerId });
				for (const row of rows) {
					if (!readable.has(row.id) || !readable.has(row.rootId)) continue;
					if (opposite && chips.unavailableNoteIds?.has(row.rootId)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
					const rootChip = chips.get(row.rootId)?.find(chip => chip.origin === channelOrigin && chip.channelId === input.channelId && chip.state === 'active');
					if (!rootChip) continue;
					const chip: PackedChannelPlacement = { origin: channelOrigin, channelId: rootChip.channelId, canonicalUri: row.canonicalUri,
																																												name: rootChip.name, color: rootChip.color, isArchived: rootChip.isArchived, isSensitive: rootChip.isSensitive,
																																												allowRenoteToExternal: rootChip.allowRenoteToExternal, state: 'active', canRemove: false, canRetry: false };
					result.push({ source: 'local', normalized: true, generation: 2, noteId: row.id, sortAt: row.sortAt, canonicalUri: row.canonicalUri,
																			placement: { channelId: chip.channelId, channelIds: [chip.channelId], channelOrigin, noteOrigin: this.peer!.origin,
																																includeDefault: false, legacy: false, chips: [chip] } });
				}
			}
			if (rows.length < 100) break;
			before = rows.at(-1)!;
		}
		const references = result.slice(0, limit);
		const last = references.at(-1);
		return { references, next: result.length > limit && last ? { sortAt: last.sortAt, canonicalUri: last.canonicalUri } : null };
	}

	public async changedReplies(channelOrigin: string, channelId: string, ids: string[], viewerId: string): Promise<boolean> {
		if (!this.peer || !ids.length) return false;
		for (let offset = 0; offset < ids.length; offset += 100) {
			const uris = ids.slice(offset, offset + 100).map(id => this.peer!.origin + '/notes/' + id);
			const page = await this.replyPage({ channelId, replyChannelOrigin: channelOrigin, uris, limit: 1 }, viewerId, Date.now() + 8000);
			if (page.references.length) return true;
		}
		return false;
	}

	private async readIndex(input: PlacementTimelineRequest, viewerId: string, remote: boolean, deadline: number): Promise<PlacementPage> {
		if (!input.includeReplies && !input.replyChannelOrigin) return this.query(input, viewerId, remote);
		if (!input.includeReplies || !input.channelId || input.followed || input.pinnedOnly ||
			(input.replyChannelOrigin && input.replyChannelOrigin !== this.peer!.peerOrigin)) throw new GridspaceLinkError('INVALID_REQUEST');
		const updates = input.after ? await this.changes.changes(input.after) : null;
		const sequence = updates?.cursor ?? await this.changes.currentPosition();
		const roots = input.replyChannelOrigin ? null : await this.query({ ...input, after: undefined }, viewerId, remote);
		const replies = await this.replyPage(input, viewerId, deadline);
		const sorted = [...roots?.references ?? [], ...replies.references].sort(comparePlacementPosition);
		const limit = input.limit ?? 50;
		const references = sorted.slice(0, limit);
		const key = (r: TimelineReference) => ({ sortAt: r.sortAt, canonicalUri: r.canonicalUri });
		const channelOrigin = input.replyChannelOrigin ?? this.peer!.origin;
		const changed = updates ? updates.resetRequired || updates.hasMore || updates.events.some(e =>
			(e.channelId === input.channelId && e.channelOrigin === channelOrigin) ||
			(e.kind === 'policy' && (!e.affectedUserId || e.affectedUserId === viewerId))) ||
			await this.changedReplies(channelOrigin, input.channelId, updates.events.flatMap(e => !e.channelId && e.noteId ? [e.noteId] : []), viewerId) : undefined;
		return { references, upper: input.upper ?? (references[0] ? key(references[0]) : null),
											next: references.length && (roots?.next || replies.next || sorted.length > limit) ? key(references.at(-1)!) : null, sequence, changed };
	}

	private async query(input: PlacementTimelineRequest, viewerId: string, remote: boolean, linkedId?: string): Promise<PlacementPage> {
		if (!!input.followed === !!input.channelId || (input.channelId && !gridspaceNoteId(input.channelId))) throw new GridspaceLinkError('INVALID_REQUEST');
		const limit = input.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (input.uris?.length ?? 0) > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		const followIds = linkedId ? [viewerId, linkedId] : [viewerId];
		const blockedViewer = input.followed ? 'ANY($1::varchar[])' : '$3';
		const params: unknown[] = [input.followed ? followIds : input.channelId, this.peer!.origin, viewerId];
		const conditions: string[] = [`NOT EXISTS (SELECT 1 FROM channel c JOIN blocking b ON
			((b."blockerId" = c."userId" AND b."blockeeId" = ${blockedViewer}) OR (b."blockerId" = ${blockedViewer} AND b."blockeeId" = c."userId"))
			WHERE c.id = a."channelId")`];
		if (input.followed) conditions.push('NOT a.legacy');

		for (const [op, value] of [['<', input.before], ['<=', input.upper]] as const) {
			if (!value) continue;
			if (!validTimelinePosition(value)) throw new GridspaceLinkError('INVALID_CURSOR');
			if (input.pinnedOnly) {
				if (!Number.isSafeInteger(value.pinRank) || value.pinRank! < 0) throw new GridspaceLinkError('INVALID_CURSOR');
				params.push(value.pinRank, value.canonicalUri);
				conditions.push(`(-pins.rank, a."canonicalUri" COLLATE "C") ${op} (-$${params.length - 1}::int, $${params.length} COLLATE "C")`);
				continue;
			}
			params.push(value.sortAt, value.canonicalUri);
			conditions.push(`(a."sortAt", a."canonicalUri" COLLATE "C") ${op} (to_timestamp($${params.length - 1}::bigint / 1000000.0), $${params.length} COLLATE "C")`);
		}
		if (input.untilAt !== undefined) {
			params.push(input.untilAt + 1);
			conditions.push(`a."sortAt" < to_timestamp($${params.length}::bigint / 1000.0)`);
		}
		if (input.uris) {
			params.push(input.uris);
			conditions.push(`a."canonicalUri" = ANY($${params.length}::varchar[])`);
		}
		const pinJoin = input.pinnedOnly ? `JOIN LATERAL (SELECT coalesce((SELECT p.rank FROM channel_placement_pin p
			WHERE p."channelId" = c.id AND p."canonicalUri" = a."canonicalUri"), array_position(c."pinnedNoteIds", a."localNoteId") - 1) AS rank) pins ON pins.rank IS NOT NULL` : '';
		const updates = input.after ? await this.changes.changes(input.after) : null;
		const sequence = updates?.cursor ?? await this.changes.currentPosition();
		const changedChannels = updates?.events.flatMap(event => event.channelId && event.channelOrigin === this.peer!.origin ? [event.channelId] : []) ?? [];
		const listChanged = input.followed ? await this.followsAny(viewerId, changedChannels, linkedId) : changedChannels.includes(input.channelId!);
		const changed = updates ? updates.resetRequired || updates.hasMore || listChanged || updates.events.some(event =>
			event.kind === 'policy' && (!event.affectedUserId || followIds.includes(event.affectedUserId))) : undefined;
		const moderator = !remote && await this.roles.isModerator({ id: viewerId });
		params.push(moderator, limit + 1);
		const watched = input.followed ? `WITH watched AS (SELECT cf."followeeId" AS id FROM channel_following cf
			WHERE cf."followerId" = ANY($1::varchar[]) AND NOT EXISTS (SELECT 1 FROM channel_muting cm WHERE cm."userId" = ANY($1::varchar[]) AND cm."channelId" = cf."followeeId"
				AND (cm."expiresAt" IS NULL OR cm."expiresAt" > CURRENT_TIMESTAMP)))` : '';
		const rows = await this.db.query<{ pinRank: number | null; chips: PackedChannelPlacement[]; channelIds: string[]; sortAt: string; canonicalUri: string; originNoteId: string; noteOrigin: string; includeDefault: boolean; legacy: boolean }[]>(
			`${watched} SELECT ${input.pinnedOnly ? 'min(pins.rank)' : 'NULL::int'} AS "pinRank", array_agg(DISTINCT a."channelId" ORDER BY a."channelId") AS "channelIds",
				jsonb_agg(DISTINCT jsonb_build_object('origin', $2::text, 'channelId', c.id, 'name', c.name, 'color', c.color,
					'isArchived', c."isArchived", 'isSensitive', c."isSensitive", 'allowRenoteToExternal', c."allowRenoteToExternal",
					'canonicalUri', a."canonicalUri" COLLATE "C", 'state', 'active', 'canRemove',
					(NOT a.legacy AND ($${params.length - 1}::boolean OR c."userId" = $3 OR a."authorUri" IN
					(SELECT coalesce(u.uri, $2 || '/users/' || u.id) FROM "user" u WHERE u.id = $3))))) AS chips,
				(extract(epoch FROM a."sortAt") * 1000000)::bigint::text AS "sortAt", a."canonicalUri" COLLATE "C" AS "canonicalUri",
				a."originNoteId", a."noteOrigin", a."includeDefault", a.legacy, a."sortAt" AS "entryTime"
			FROM (${activeChannelEntries(this.config.id, input.followed)}) a JOIN channel c ON c.id = a."channelId" ${pinJoin} ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
			GROUP BY a."sortAt", a."canonicalUri" COLLATE "C", a."originNoteId", a."noteOrigin", a."includeDefault", a.legacy
			ORDER BY ${input.pinnedOnly ? '"pinRank" ASC' : '"entryTime" DESC'}, "canonicalUri" DESC LIMIT $${params.length}`, params);
		const references: TimelineReference[] = rows.slice(0, limit).map(row => ({ source: 'local', normalized: true, generation: 2,
																																																																													sortAt: row.sortAt, ...(row.pinRank == null ? {} : { pinRank: row.pinRank }), sourceId: row.canonicalUri, canonicalUri: row.canonicalUri, noteId: row.originNoteId,
																																																																													placement: { channelId: row.channelIds[0], channelIds: row.channelIds, chips: row.legacy ? [] : row.chips, channelOrigin: this.peer!.origin, noteOrigin: row.noteOrigin, includeDefault: row.includeDefault, legacy: row.legacy } }));
		const key = (r: TimelineReference): Position => ({ sortAt: r.sortAt, canonicalUri: r.canonicalUri, pinRank: r.pinRank });
		return { references, upper: input.upper ?? (references[0] ? key(references[0]) : null), next: rows.length > limit ? key(references.at(-1)!) : null, sequence, changed };
	}

	public async read(viewer: MiLocalUser, origin: string, input: PlacementTimelineRequest, deadline: number): Promise<PlacementPage> {
		if (!this.peer) throw new GridspaceLinkError('UNAVAILABLE');
		const explicit = !!input.channelId && !input.followed && !input.pinnedOnly;
		if (input.replyChannelOrigin && (!explicit || !await this.placementService.supportsChannelReplies())) {
			return { references: [], next: null, upper: null, sequence: '0' };
		}
		if (origin === this.peer.origin) return this.readIndex({ ...input, includeReplies: explicit }, viewer.id, false, deadline);
		if (origin !== this.peer.peerOrigin) throw new GridspaceLinkError('INVALID_REQUEST');
		const actor = await this.placementService.currentActorCredential(viewer);
		const includeReplies = explicit && await this.placementService.supportsChannelReplies();
		let channel: Awaited<ReturnType<GridspaceChannelAuthService['destination']>> | undefined;
		if (input.followed && this.channelAuth.isClient && await this.placementService.supportsLinkedChannelFollows()) {
			try {
				channel = await this.channelAuth.destination(viewer);
			} catch (error) {
				// A link without a private read grant still has independent current-actor follows.
				if (!(error instanceof GridspaceLinkError) || error.code !== 'AUTHORIZATION_REVOKED') throw error;
			}
		}
		const followedLink = channel && 'accessToken' in channel.credential ? channel.credential : undefined;
		let result: PlacementPage;
		try {
			result = await requestGridspacePeer(this.peer, '/gridspace/v1/placements/timeline', { ...input, ...actor, followedLink, ...(includeReplies ? { includeReplies: true } : {}) }, 512 * 1024, deadline) as PlacementPage;
		} catch { throw new GridspaceLinkError('PEER_UNAVAILABLE'); }
		if (channel) await channel.check();
		if (!Array.isArray(result?.references) || result.references.length > (input.limit ?? 50) || !/^\d+$/.test(result.sequence) ||
			(result.next && !validTimelinePosition(result.next)) || (result.upper && !validTimelinePosition(result.upper))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		for (const ref of result.references) {
			const p = ref.placement;
			if (!p || p.channelOrigin !== (input.replyChannelOrigin ?? origin) || (input.channelId ? p.channelId !== input.channelId : !gridspaceNoteId(p.channelId)) || !gridspaceNoteId(ref.noteId) ||
				!validTimelinePosition(ref) || ![origin, this.peer.origin].includes(p.noteOrigin) ||
				typeof p.legacy !== 'boolean' || (input.replyChannelOrigin && (p.noteOrigin !== origin || p.legacy || p.includeDefault)) || typeof p.includeDefault !== 'boolean' ||
				(!p.legacy && (!Array.isArray(p.chips) || p.chips.some(chip => chip.origin !== p.channelOrigin || chip.canonicalUri !== ref.canonicalUri ||
					(input.replyChannelOrigin && (chip.channelId !== input.channelId || chip.canRemove !== false || chip.canRetry || chip.placementId)) ||
					!gridspaceNoteId(chip.channelId) || typeof chip.name !== 'string' || typeof chip.color !== 'string' || chip.state !== 'active' ||
					[chip.isArchived, chip.isSensitive, chip.allowRenoteToExternal].some(flag => flag !== undefined && typeof flag !== 'boolean')))) ||
				(!p.legacy && ref.canonicalUri !== `${p.noteOrigin}/notes/${ref.noteId}`)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			ref.source = 'peer';
		}
		return result;
	}

	public async bodies(viewer: MiLocalUser, refs: TimelineReference[], deadline: number, filters: Pick<TimelineOptions, 'withRenotes' | 'includeMyRenotes'> = {}): Promise<Map<string, PlacementBody>> {
		const result = new Map<string, PlacementBody>();
		if (!this.peer || !refs.length) return result;
		const started = Date.now();
		const local: TimelineReference[] = [];
		const normal = refs.filter(ref => ref.placement!.noteOrigin === this.peer!.peerOrigin && ref.placement!.includeDefault);
		const aliases = normal.flatMap(ref => gridspaceNoteUris(ref.canonicalUri, this.peer!.peerOrigin));
		const mirrors = aliases.length ? await this.db.getRepository(MiNote).createQueryBuilder('n').select(['n.id', 'n.uri'])
			.where('n.uri IN (:...aliases)', { aliases }).getMany() : [];
		const byUri = new Map(mirrors.map(row => [canonicalGridspaceNoteUri(row.uri!, this.peer!.peerOrigin), row.id]));
		const missing = normal.filter(ref => !byUri.has(ref.canonicalUri));
		const budget = { remaining: 128, deadline: Math.min(deadline, Date.now() + 2500) };
		for (let offset = 0; offset < missing.length; offset += 20) {
			const batch = missing.slice(offset, offset + 20);
			let imported: Awaited<ReturnType<GridspaceNoteService['historyNotes']>>;
			try {
				imported = await this.shared.historyNotes([...new Set(batch.map(ref => ref.noteId))], budget);
			} catch {
				// Origin reads can still supply an authorized read-only body.
				continue;
			}
			for (const ref of batch) {
				const note = imported.get(ref.noteId);
				if (note?.uri && canonicalGridspaceNoteUri(note.uri, this.peer.peerOrigin) === ref.canonicalUri) byUri.set(ref.canonicalUri, note.id);
			}
		}
		for (const ref of refs) {
			const placement = ref.placement!;
			const id = placement.noteOrigin === this.peer.origin ? ref.noteId : byUri.get(ref.canonicalUri);
			if (id) local.push({ ...ref, noteId: id });
		}
		const rows = await this.local.hydrateQuery(viewer, async () => this.local.readableQuery(viewer), local);
		for (const row of rows) result.set(row.reference.canonicalUri, { representation: 'normal', payload: row.payload, validForMs: row.validForMs, nextPolicyCheckAt: row.nextPolicyCheckAt });
		const remote = refs.filter(ref => ref.placement!.noteOrigin === this.peer!.peerOrigin);
		const batches: TimelineReference[][] = [];
		const legacyChannels = new Map<string, TimelineReference[]>();
		for (const ref of remote) {
			if (!ref.placement!.legacy) {
				// A conversation has its own authorization scope; do not share it with other notes.
				batches.push([ref]);
				continue;
			}
			const channelId = ref.placement!.channelId;
			let batch = legacyChannels.get(channelId);
			if (!batch || batch.length >= 100) {
				batch = [];
				legacyChannels.set(channelId, batch);
				batches.push(batch);
			}
			batch.push(ref);
		}
		for (let offset = 0; offset < batches.length; offset += 4) {
			await Promise.all(batches.slice(offset, offset + 4).map(async batch => {
				if (Date.now() >= deadline) throw new GridspaceLinkError('PEER_UNAVAILABLE');
				const first = batch[0];
				let page: Awaited<ReturnType<GridspacePrivateService['notes']>>;
				try {
					page = await this.delegated.notes(viewer, first.placement!.legacy
						? { mode: 'validate', contextMode: 'channel', channelId: first.placement!.channelId, ids: batch.map(ref => ref.noteId) }
						: { mode: 'show', noteId: first.noteId, conversationUri: first.canonicalUri }, batch.length);
				} catch (error) {
					if (!(error instanceof GridspaceLinkError) || !['ACTION_REJECTED', 'AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code)) throw error;
					for (const ref of batch) result.delete(ref.canonicalUri);
					return;
				}
				for (const ref of batch) {
					const note = page.notes.find(note => note.id === ref.noteId && note.origin === ref.placement!.noteOrigin && canonicalGridspaceNoteUri(note.uri, this.peer!.peerOrigin) === ref.canonicalUri);
					if (!note) {
						result.delete(ref.canonicalUri);
						continue;
					}
					const mirror = result.get(ref.canonicalUri);
					if (mirror && note.channelPlacements?.length) {
						const all = new Map(note.channelPlacements.map(chip => [JSON.stringify([chip.origin, chip.channelId]), chip]));
						for (const chip of mirror.payload.channelPlacements ?? []) all.set(JSON.stringify([chip.origin, chip.channelId]), chip);
						mirror.payload.channelPlacements = [...all.values()];
					}
					if (!ref.placement!.includeDefault || !byUri.has(ref.canonicalUri)) {
						const readOnly = ref.placement!.includeDefault;
						if (readOnly) {
							delete note.myReaction;
							delete note.myReactions;
							for (const choice of note.poll?.choices ?? []) delete choice.isVoted;
							note.canDelete = false;
							note.canSelfRenote = false;
						}
						result.set(ref.canonicalUri, { representation: 'delegated', payload: note, readOnly, validForMs: TIMELINE_AUTHORIZATION_TTL_MS, nextPolicyCheckAt: null });
					}
				}
			}));
		}
		// A dedicated peer original has no local note ID. Resolve its author URI
		// against the viewer's renote mutes in the same batch as native authors.
		const native = new Map<string, string>();
		const delegated = new Map<string, string>();
		for (const [uri, { payload }] of result) {
			if ((!payload.gridspaceQuote && !payload.renoteId) || payload.text != null || payload.cw != null || payload.replyId || payload.files?.length || payload.poll) continue;
			if (filters.withRenotes === false) {
				result.delete(uri);
				continue;
			}
			if ('userId' in payload) native.set(uri, payload.userId);
			else delegated.set(uri, payload.author.uri);
		}
		if (native.size || delegated.size) {
			const muted = await this.db.query<{ id: string; uri: string | null }[]>(`SELECT u.id, coalesce(u.uri, $2 || '/users/' || u.id) AS uri
				FROM renote_muting m INNER JOIN "user" u ON u.id = m."muteeId" WHERE m."muterId" = $1
				AND (u.id = ANY($3::varchar[]) OR coalesce(u.uri, $2 || '/users/' || u.id) = ANY($4::varchar[]))`,
			[viewer.id, this.peer.origin, [...new Set(native.values())], [...new Set(delegated.values())]]);
			const mutedIds = new Set(muted.map(row => row.id));
			const mutedUris = new Set(muted.map(row => row.uri));
			const viewerUri = `${this.peer.origin}/users/${viewer.id}`;
			for (const [uri, id] of native) if (mutedIds.has(id) || (filters.includeMyRenotes === false && id === viewer.id)) result.delete(uri);
			for (const [uri, authorUri] of delegated) if (mutedUris.has(authorUri) || (filters.includeMyRenotes === false && authorUri === viewerUri)) result.delete(uri);
		}
		for (const body of result.values()) body.validForMs = Math.max(0, Math.min(body.validForMs ?? TIMELINE_AUTHORIZATION_TTL_MS, TIMELINE_AUTHORIZATION_TTL_MS) - (Date.now() - started));
		return result;
	}
}
