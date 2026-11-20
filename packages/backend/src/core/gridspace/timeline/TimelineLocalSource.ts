/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { type DataSource, type SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Packed } from '@/misc/json-schema.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';
import { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { IdService } from '@/core/IdService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { Config } from '@/config.js';
import { GridspaceIdentityService } from '../GridspaceIdentityService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { GridspaceSearchService } from '../GridspaceSearchService.js';
import { canonicalGridspaceNoteUri, gridspaceNoteUris } from '../note-protocol.js';
import { TIMELINE_AUTHORIZATION_TTL_MS, type TimelinePosition, type TimelineReference } from './timeline-protocol.js';

export type TimelineLocalOptions = {
	kind: 'home' | 'social';
	withReplies?: boolean;
	withRenotes?: boolean;
	withFiles?: boolean;
	includeMyRenotes?: boolean;
	includeRenotedMyNotes?: boolean;
	includeLocalRenotes?: boolean;
};

export type HydratedTimelineNote = {
	reference: TimelineReference;
	payload: Packed<'Note'>;
	validForMs: number | null;
	nextPolicyCheckAt: string | null;
};

/** Next instant at which a relative author policy can change a visible body. */
export function timelinePolicyDeadline(note: Pick<Packed<'Note'>, 'createdAt' | 'userId' | 'user'>, viewerId: string, now: number): number | null {
	if (note.userId === viewerId) return null;
	const createdAt = Date.parse(note.createdAt);
	if (!Number.isFinite(createdAt)) return now;
	const deadlines = [note.user.makeNotesHiddenBefore, note.user.makeNotesFollowersOnlyBefore]
		.filter((value): value is number => value != null && value <= 0)
		.map(value => createdAt - value * 1000)
		.filter(value => value > now);
	return deadlines.length ? Math.min(...deadlines) : null;
}

function bodyVersion(note: MiNote): string {
	// Changes to reactions/counters are harmless, but never return a body packed
	// before an edit to its audience, attachments, relations or author policy.
	return JSON.stringify([note.userId, note.visibility, note.visibleUserIds, note.text, note.cw, note.fileIds,
		note.replyId, note.renoteId, note.hasPoll, note.user?.isDeleted, note.user?.isSuspended,
		note.user?.makeNotesHiddenBefore, note.user?.makeNotesFollowersOnlyBefore]);
}

@Injectable()
export class TimelineLocalSource {
	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		@Inject(DI.config) private readonly config: Config,
		private readonly search: GridspaceSearchService,
		private readonly queries: QueryService,
		private readonly identity: GridspaceIdentityService,
		private readonly roles: RoleService,
		private readonly notes: NoteEntityService,
		private readonly ids: IdService,
	) {}

	/** Live and historical reads use the same current subscriptions and ACL. */
	public async buildQuery(viewer: MiLocalUser, options: TimelineLocalOptions, singleNote?: { id?: string }): Promise<SelectQueryBuilder<MiNote>> {
		if (viewer.isSuspended || viewer.isDeleted) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (options.kind === 'social' && !(await this.roles.getUserPolicies(viewer.id)).ltlAvailable) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const linkedId = singleNote ? null : await this.identity.linkedUserId(viewer.id);
		const query = this.readableQuery(viewer, singleNote?.id).setParameters({ timelineViewer: viewer.id, timelineLinked: linkedId });
		// Keep link resolution in the same statement as the current note ACL. This
		// avoids loading the complete link and remote user before every check.
		const linked = singleNote && this.config.gridspace?.enabled
			? `(SELECT linked.id FROM gridspace_link gl INNER JOIN "user" linked ON linked.uri = gl."peerOrigin" || '/users/' || gl."peerUserId" WHERE gl."localUserId" = :timelineViewer AND gl.state = 'active' LIMIT 1)`
			: ':timelineLinked';
		const followed = (column: string) => `EXISTS (SELECT 1 FROM following tf WHERE tf."followerId" = :timelineViewer AND tf."followeeId" = ${column})`;
		const self = `(note."userId" = :timelineViewer OR (note."userId" = ${linked} AND note.visibility IN ('public', 'home')))`;
		const channels = `EXISTS (SELECT 1 FROM channel_following tcf WHERE tcf."followerId" = :timelineViewer AND tcf."followeeId" = note."channelId")`;
		const publicLocal = options.kind === 'social' ? ` OR (note.visibility = 'public' AND (note."userHost" IS NULL OR note."gridspaceShared" = true))` : '';
		query.andWhere(`((note."channelId" IS NULL AND (${self} OR ${followed('note."userId"')}${publicLocal})) OR ${channels})`);
		// withReplies belongs to each follow on home; social additionally has the
		// explicit global switch. Self replies and replies to the viewer remain.
		const expandedReplies = options.kind === 'social' && options.withReplies === true ? 'true'
			: `EXISTS (SELECT 1 FROM following trf WHERE trf."followerId" = :timelineViewer AND trf."followeeId" = note."userId" AND trf."withReplies" = true)`;
		const readableReply = `(reply.visibility IS DISTINCT FROM 'followers' OR reply."userId" = :timelineViewer OR ${followed('reply."userId"')})`;
		query.andWhere(`(note."replyId" IS NULL OR ((${expandedReplies}) AND ${readableReply}) OR (NOT (${expandedReplies}) AND (${self} OR note."replyUserId" = :timelineViewer OR note."replyUserId" = note."userId")))`);
		const pureRenote = `((note."renoteId" IS NOT NULL OR note."gridspaceQuote" IS NOT NULL) AND note.text IS NULL AND note.cw IS NULL AND note."replyId" IS NULL AND cardinality(note."fileIds") = 0 AND note."hasPoll" = false)`;
		query.andWhere(`(NOT ${pureRenote} OR NOT EXISTS (SELECT 1 FROM note trn INNER JOIN note trr ON trr.id = trn."replyId" WHERE trn.id = note."renoteId" AND trr.visibility = 'followers' AND trr."userId" <> :timelineViewer AND NOT ${followed('trr."userId"')}))`);
		if (options.withRenotes === false) query.andWhere(`NOT ${pureRenote}`);
		if (options.includeMyRenotes === false) query.andWhere(`(NOT ${pureRenote} OR note."userId" IS DISTINCT FROM :timelineViewer)`);
		if (options.includeRenotedMyNotes === false) query.andWhere(`(NOT ${pureRenote} OR note."renoteUserId" IS DISTINCT FROM :timelineViewer)`);
		if (options.includeLocalRenotes === false) query.andWhere(`NOT (${pureRenote} AND note."renoteId" IS NOT NULL AND note."renoteUserHost" IS NULL)`);
		if (options.withFiles) query.andWhere('cardinality(note."fileIds") > 0');
		this.queries.generateMutedNoteThreadQuery(query, viewer);
		this.queries.generateMutedUserRenotesQueryForNotes(query, viewer);
		return query;
	}

	public async read(viewer: MiLocalUser, options: TimelineLocalOptions, position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; limit: number; normalizedOnly?: boolean }): Promise<TimelineReference[]> {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 512) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = await this.buildQuery(viewer, options);
		if (position.untilAt != null) {
			if (!Number.isSafeInteger(position.untilAt) || position.untilAt < 0 || position.untilAt >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			query.andWhere('note.id < :timelineUntilAt', { timelineUntilAt: this.ids.gen(position.untilAt + 1) });
		}
		for (const [name, boundary, operator] of [['before', position.before, '<'], ['upper', position.upper, '<=']] as const) {
			if (!boundary) continue;
			if (!boundary.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere(`note.id ${operator} :timeline${name}`, { [`timeline${name}`]: boundary.noteId });
		}
		const rows = await this.search.read(query.orderBy('note.id', 'DESC').limit(position.limit));
		return rows.map(note => this.reference(note));
	}

	/** Scan at most one small primary-key window, including for an empty home. */
	public async readPage(viewer: MiLocalUser, options: TimelineLocalOptions, position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; limit: number }): Promise<{ references: TimelineReference[]; next: TimelineReference | null; upper: TimelinePosition | null; ended: boolean }> {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 50) throw new GridspaceLinkError('INVALID_REQUEST');
		const scan = this.db.getRepository(MiNote).createQueryBuilder('candidate').select(['candidate.id', 'candidate.uri']);
		for (const [name, boundary, operator] of [['before', position.before, '<'], ['upper', position.upper, '<=']] as const) {
			if (!boundary) continue;
			if (!boundary.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			scan.andWhere(`candidate.id ${operator} :timeline${name}`, { [`timeline${name}`]: boundary.noteId });
		}
		if (position.untilAt != null) {
			if (!Number.isSafeInteger(position.untilAt) || position.untilAt < 0 || position.untilAt >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			scan.andWhere('candidate.id < :timelineUntilAt', { timelineUntilAt: this.ids.gen(position.untilAt + 1) });
		}
		const candidates = await scan.orderBy('candidate.id', 'DESC').limit(513).getMany();
		const window = candidates.slice(0, 512);
		const upper = position.upper ?? (window[0] ? this.reference(window[0]) : null);
		if (window.length === 0) return { references: [], next: null, upper, ended: true };
		const query = (await this.buildQuery(viewer, options)).andWhere('note.id IN (:...timelineWindow)', { timelineWindow: window.map(note => note.id) });
		const eligible = await this.search.read(query.orderBy('note.id', 'DESC').limit(position.limit + 1));
		const references = eligible.slice(0, position.limit).map(note => this.reference(note));
		const hasMore = eligible.length > position.limit || candidates.length > 512;
		const boundary = eligible.length > position.limit ? references.at(-1)! : this.reference(window.at(-1)!);
		return { references, next: hasMore ? boundary : null, upper, ended: !hasMore };
	}

	/** The local representation wins only if it can actually expose a body now. */
	public async ownerReferences(viewer: MiLocalUser, options: TimelineLocalOptions, uris: string[], upper?: TimelinePosition | null): Promise<TimelineReference[]> {
		const refs = await this.ownerCandidates(viewer, options, uris, upper);
		return (await this.hydrate(viewer, options, refs)).map(item => item.reference);
	}

	/** Current root ACL only; callers must hydrate before exposing any body. */
	public async ownerCandidates(viewer: MiLocalUser, options: TimelineLocalOptions, uris: string[], upper?: TimelinePosition | null, compact = false): Promise<TimelineReference[]> {
		if (uris.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if (!uris.length || upper === null) return [];
		const localPrefix = `${this.config.url}/notes/`;
		const ids = uris.filter(uri => uri.startsWith(localPrefix)).map(uri => uri.slice(localPrefix.length)).filter(id => /^[a-zA-Z0-9]{1,32}$/.test(id));
		const aliases = [...new Set(uris.flatMap(uri => gridspaceNoteUris(uri, this.config.gridspace?.peerUrl)))];
		const query = await this.buildQuery(viewer, options, compact ? { id: uris.length === 1 && ids.length === 1 ? ids[0] : undefined } : undefined);
		query.andWhere(`(note.uri IN (:...timelineOwnerUris)${ids.length ? ' OR note.id IN (:...timelineOwnerIds)' : ''})`, { timelineOwnerUris: aliases, timelineOwnerIds: ids });
		if (upper) {
			if (!upper.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(upper.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere('note.id <= :timelineOwnerUpper', { timelineOwnerUpper: upper.noteId });
		}
		// Ownership needs identity only. The query still applies all current ACLs.
		const candidates = compact ? await query.select(['note.id', 'note.uri']).limit(200).getMany() : await this.search.read(query.limit(200));
		const wanted = new Set(uris);
		const byUri = new Map<string, TimelineReference>();
		for (const note of candidates) {
			const ref = this.reference(note);
			if (wanted.has(ref.canonicalUri) && !byUri.has(ref.canonicalUri)) byUri.set(ref.canonicalUri, ref);
		}
		return [...byUri.values()];
	}

	public async anchor(viewer: MiLocalUser, options: TimelineLocalOptions, canonicalUri: string): Promise<TimelineReference | null> {
		return (await this.ownerReferences(viewer, options, [canonicalUri]))[0] ?? null;
	}

	private reference(note: Pick<MiNote, 'id' | 'uri'>): TimelineReference {
		return { noteId: note.id, canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.config.url}/notes/${note.id}`, this.config.gridspace?.peerUrl),
			sortAt: (BigInt(this.ids.parse(note.id).date.getTime()) * 1000n).toString(), normalized: true, generation: 1, source: 'local' };
	}

	public async hydrate(viewer: MiLocalUser, options: TimelineLocalOptions, references: TimelineReference[]): Promise<HydratedTimelineNote[]> {
		return this.hydrateQuery(viewer, () => this.buildQuery(viewer, options), references);
	}

	/** Exact-ID stream path, with the same before/after and nested-body checks. */
	public async hydrateSingle(viewer: MiLocalUser, options: TimelineLocalOptions, reference: TimelineReference): Promise<HydratedTimelineNote[]> {
		return this.hydrateQuery(viewer, () => this.buildQuery(viewer, options, { id: reference.noteId }), [reference], true);
	}

	/** Shared packing/revalidation for the other indexed note-list adapters. */
	public async hydrateQuery(viewer: MiLocalUser, buildQuery: () => Promise<SelectQueryBuilder<MiNote>>, references: TimelineReference[], compact = false): Promise<HydratedTimelineNote[]> {
		if (references.length === 0) return [];
		if (references.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		const requested = [...new Set(references.map(reference => reference.noteId))];
		const before = await (await buildQuery()).andWhere('note.id IN (:...timelineIds)', { timelineIds: requested }).getMany();
		if (!before.length) return [];
		const versions = new Map(before.map(note => [note.id, bodyVersion(note)]));
		const payloads = await this.notes.packMany(before, viewer);
		const packedIds = new Set<string>();
		const collect = (note: Packed<'Note'>) => {
			if (packedIds.has(note.id)) return;
			packedIds.add(note.id);
			if (note.reply) collect(note.reply);
			if (note.renote) collect(note.renote);
		};
		for (const note of payloads) collect(note);
		const nestedIds = compact ? [...packedIds].filter(id => !requested.includes(id)) : [...packedIds];
		const freshQuery = (await buildQuery()).andWhere('note.id IN (:...timelineIds)', { timelineIds: requested });
		if (compact) freshQuery.select([
			'note.id', 'note.uri', 'note.userId', 'note.name', 'note.url', 'note.text', 'note.cw', 'note.fileIds',
			'note.visibility', 'note.visibleUserIds', 'note.replyId', 'note.renoteId', 'note.hasPoll',
			'user.id', 'user.isDeleted', 'user.isSuspended', 'user.makeNotesFollowersOnlyBefore', 'user.makeNotesHiddenBefore',
		]);
		// Rebuild after packing: actor/link/subscription changes must not reuse the
		// initial authorization. Nested quotes/replies get independent visibility.
		const [fresh, related, viewerDeadline] = await Promise.all([
			freshQuery.getMany(),
			nestedIds.length ? this.readableQuery(viewer).andWhere('note.id IN (:...timelineRelated)', { timelineRelated: nestedIds }).getMany() : Promise.resolve([]),
			this.nextViewerPolicyCheck(viewer.id),
		]);
		const allowed = new Map(fresh.filter(note => versions.get(note.id) === bodyVersion(note)).map(note => [note.id, note]));
		// The caller's root query is authoritative for list-specific exceptions
		// (for example a muted author's explicitly opened profile).
		const relatedAllowed = new Map([...related, ...fresh].map(note => [note.id, note]));
		const packed = new Map(payloads.map(note => [note.id, note]));
		const now = Date.now();
		const sanitize = (note: Packed<'Note'>): boolean => {
			const row = relatedAllowed.get(note.id);
			if (!row || !row.user || note.isHidden || row.userId !== note.userId) return false;
			const expectedText = row.name && (row.url ?? row.uri) ? `【${row.name}】\n${(row.text ?? '').trim()}\n\n${row.url ?? row.uri}` : row.text;
			const expectedVisibility = (row.visibility === 'public' || row.visibility === 'home') && shouldHideNoteByTime(row.user.makeNotesFollowersOnlyBefore, note.createdAt) ? 'followers' : row.visibility;
			if (expectedText !== note.text || row.cw !== note.cw || JSON.stringify(row.fileIds) !== JSON.stringify(note.fileIds) ||
				row.replyId !== note.replyId || row.renoteId !== note.renoteId || expectedVisibility !== note.visibility ||
				(row.user.makeNotesFollowersOnlyBefore ?? null) !== (note.user.makeNotesFollowersOnlyBefore ?? null) || (row.user.makeNotesHiddenBefore ?? null) !== (note.user.makeNotesHiddenBefore ?? null) ||
				(row.userId !== viewer.id && shouldHideNoteByTime(row.user.makeNotesHiddenBefore, note.createdAt))) return false;
			for (const relation of ['reply', 'renote'] as const) {
				const nested = note[relation];
				if (nested && !sanitize(nested)) { note[relation] = null; note[`${relation}Id`] = null; }
			}
			return true;
		};
		const result: HydratedTimelineNote[] = [];
		for (const reference of references) {
			const payload = packed.get(reference.noteId);
			const row = allowed.get(reference.noteId);
			if (!row || !payload || this.reference(row).canonicalUri !== reference.canonicalUri || !sanitize(payload)) continue;
			const deadlines: number[] = viewerDeadline == null ? [] : [viewerDeadline];
			let restricted = false;
			const visit = (note: Packed<'Note'>) => {
				// Audience-bound and channel bodies must disappear independently of a
				// failed refresh, including restricted notes nested in public posts.
				if (note.visibility === 'followers' || note.visibility === 'specified' || note.channelId != null) restricted = true;
				const deadline = timelinePolicyDeadline(note, viewer.id, now);
				if (deadline != null) deadlines.push(deadline);
				if (note.reply) visit(note.reply);
				if (note.renote) visit(note.renote);
			};
			visit(payload);
			const next = deadlines.length ? Math.min(...deadlines) : null;
			if (next != null && next <= now) continue;
			result.push({ reference, payload, validForMs: next == null ? restricted ? TIMELINE_AUTHORIZATION_TTL_MS : null : Math.min(TIMELINE_AUTHORIZATION_TTL_MS, next - now), nextPolicyCheckAt: next == null ? null : new Date(next).toISOString() });
		}
		return result;
	}

	private readableQuery(viewer: MiLocalUser, singleNoteId?: string): SelectQueryBuilder<MiNote> {
		return this.search.noteQuery(viewer, { query: '' }, false, true, undefined, false, true, singleNoteId)
			.andWhere('"user"."isDeleted" = false')
			.andWhere('EXISTS (SELECT 1 FROM "user" tv WHERE tv.id = :timelineViewer AND tv."isDeleted" = false AND tv."isSuspended" = false)', { timelineViewer: viewer.id });
	}

	/** Time-only changes need a retry even when no database event is emitted. */
	public async nextViewerPolicyCheck(viewerId: string): Promise<number | null> {
		const rows = await this.db.query<{ deadline: Date | string | null }[]>(`SELECT min(deadline) AS deadline FROM (
			SELECT "expiresAt" AS deadline FROM muting WHERE "muterId" = $1 AND "expiresAt" > CURRENT_TIMESTAMP
			UNION ALL SELECT "expiresAt" FROM channel_muting WHERE "userId" = $1 AND "expiresAt" > CURRENT_TIMESTAMP
			UNION ALL SELECT "expiresAt" FROM role_assignment WHERE "userId" = $1 AND "expiresAt" > CURRENT_TIMESTAMP
		) policies`, [viewerId]);
		const deadline = rows[0]?.deadline;
		return deadline == null ? null : new Date(deadline).getTime();
	}
}
