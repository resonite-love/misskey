/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiClip } from '@/models/Clip.js';
import { MiGridspaceClipReference } from '@/models/GridspaceClipReference.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { gridspaceNoteId } from './note-protocol.js';
import { searchNoteTimeSql } from './search-visibility.js';
import { TimelineLocalSource } from './timeline/TimelineLocalSource.js';
import { TIMELINE_AUTHORIZATION_TTL_MS, compareTimelinePosition, type TimelineOptions, type TimelinePosition, type TimelineReference, type TimelineItem } from './timeline/timeline-protocol.js';

type Position = { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; fromAt?: number; limit: number; uris?: string[]; deadline?: number };
type PageInput = Position & { external: boolean; order?: 'newest' | 'oldest'; query?: string; rangeStartAt?: number; rangeEndAt?: number };
type Page = { references: TimelineReference[]; next: TimelineReference | null; upper: TimelinePosition | null; ended: boolean; revision?: string };

/** Clip membership never grants access to a note, and never stores its body. */
@Injectable()
export class GridspaceClipReferenceService {
	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
		private modules: ModuleRef, private links: GridspaceLinkService, private ids: IdService,
		private roles: RoleService, private events: GlobalEventService) {}

	private get origin() { return new URL(this.config.url).origin; }
	private get peerOrigin() {
		if (!this.config.gridspace?.enabled) throw new GridspaceLinkError('DISABLED');
		return new URL(this.config.gridspace.peerUrl).origin;
	}

	private async clip(viewer: MiLocalUser, clipId: string, owned = false) {
		const clip = await this.db.getRepository(MiClip).findOne({ where: { id: clipId }, select: { id: true, userId: true, isPublic: true, lastClippedAt: true } });
		if (!clip || (clip.userId !== viewer.id && (owned || !clip.isPublic))) throw new GridspaceLinkError('UNAVAILABLE');
		return clip;
	}

	/** The caller has validated the current link, and supplies a server-owned URI. */
	public async change(viewer: MiLocalUser, clipId: string, canonicalUri: string, adding: boolean, check: () => Promise<void>) {
		const prefix = this.peerOrigin + '/notes/';
		if (!canonicalUri.startsWith(prefix) || !gridspaceNoteId(canonicalUri.slice(prefix.length))) throw new GridspaceLinkError('INVALID_REQUEST');
		const noteId = canonicalUri.slice(prefix.length);
		if (adding) {
			const page = await this.modules.get(GridspacePrivateService).notes(viewer, { mode: 'show', noteId, conversationUri: canonicalUri }, 1);
			if (!page.notes.some(note => note.id === noteId && note.uri === canonicalUri)) throw new GridspaceLinkError('UNAVAILABLE');
		}
		await check();
		const outcome = await this.db.transaction(async manager => {
			const clip = await manager.getRepository(MiClip).findOne({ where: { id: clipId, userId: viewer.id }, select: { id: true, userId: true }, lock: { mode: 'pessimistic_write' } });
			if (!clip) throw new GridspaceLinkError('UNAVAILABLE');
			await check();
			const refs = manager.getRepository(MiGridspaceClipReference);
			const existing = await refs.existsBy({ clipId, canonicalUri });
			const native = await manager.query('SELECT 1 FROM clip_note c JOIN note n ON n.id=c."noteId" WHERE c."clipId"=$1 AND n.uri=ANY($2::varchar[])', [clipId, [canonicalUri, canonicalUri + '/activity']]);
			if (adding) {
				if (existing || native.length) return 'already-added' as const;
				const [{ count }] = await manager.query('SELECT (SELECT count(*) FROM clip_note WHERE "clipId"=$1) + (SELECT count(*) FROM gridspace_clip_reference WHERE "clipId"=$1) AS count', [clipId]);
				if (Number(count) >= (await this.roles.getUserPolicies(viewer.id)).noteEachClipsLimit) return 'too-many' as const;
				await refs.insert({ clipId, canonicalUri, noteId, sortAt: this.ids.parse(noteId).date });
			} else {
				await refs.delete({ clipId, canonicalUri });
			}
			await manager.getRepository(MiClip).update(clipId, { lastClippedAt: new Date() });
			return undefined;
		});
		this.events.publishClipStream(clipId, 'updated');
		return outcome;
	}

	/** No body or browser credentials cross this membership endpoint. */
	public async peerPage(viewer: MiLocalUser, clipId: string, input: PageInput): Promise<Page> {
		const clip = await this.clip(viewer, clipId);
		if (typeof input.external !== 'boolean' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
			(input.order != null && !['newest', 'oldest'].includes(input.order)) || (input.uris && (!Array.isArray(input.uris) || input.uris.length > 100 || input.uris.some(uri => typeof uri !== 'string')))) throw new GridspaceLinkError('INVALID_REQUEST');
		const ascending = input.order === 'oldest';
		const params: unknown[] = [clipId, this.origin];
		const time = input.external ? '(extract(epoch FROM r."sortAt") * 1000000)::bigint' : `(${searchNoteTimeSql(this.config.id)}) * 1000`;
		const id = input.external ? 'r."noteId"' : 'note.id';
		const uri = input.external ? 'r."canonicalUri"' : `coalesce(note.uri, $2 || '/notes/' || note.id)`;
		const conditions = ['r."clipId"=$1', '$2::text IS NOT NULL'];
		for (const [position, op] of [[input.before, ascending ? '>' : '<'], [input.upper, '<=']] as const) {
			if (!position) continue;
			if (!/^\d{1,19}$/.test(position.sortAt) || !gridspaceNoteId(position.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			params.push(position.sortAt, position.noteId);
			conditions.push(`(${time}, ${id} COLLATE "C") ${op} ($${params.length - 1}::bigint, $${params.length} COLLATE "C")`);
		}
		for (const [value, op] of [[input.untilAt == null ? undefined : input.untilAt + 1, '<'], [input.rangeEndAt, '<'], [input.fromAt == null ? input.rangeStartAt : Math.max(0, input.fromAt - 1), '>']] as const) {
			if (value == null) continue;
			if (!Number.isSafeInteger(value) || value < 0 || value > 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			params.push(value);
			conditions.push(`${time} ${op} $${params.length}::bigint * 1000`);
		}
		if (input.uris) { params.push(input.uris); conditions.push(`${uri} = ANY($${params.length}::varchar[])`); }
		const table = input.external ? 'gridspace_clip_reference r' : 'clip_note r JOIN note ON note.id=r."noteId"';
		params.push(input.limit + 1);
		const rows = await this.db.query<{ noteId: string; canonicalUri: string; sortAt: string }[]>(`SELECT ${id} AS "noteId", ${uri} AS "canonicalUri", (${time})::text AS "sortAt" FROM ${table}
			WHERE ${conditions.join(' AND ')} ORDER BY ${time} ${ascending ? 'ASC' : 'DESC'}, ${id} COLLATE "C" ${ascending ? 'ASC' : 'DESC'} LIMIT $${params.length}`, params);
		await this.clip(viewer, clipId);
		const references = rows.slice(0, input.limit).map(row => ({ ...row, source: 'local' as const, normalized: true, generation: 1 }));
		const highest = ascending && !input.upper ? await this.db.query<{ noteId: string; canonicalUri: string; sortAt: string }[]>(`SELECT ${id} AS "noteId", ${uri} AS "canonicalUri", (${time})::text AS "sortAt" FROM ${table} WHERE r."clipId"=$1 AND $2::text IS NOT NULL ORDER BY ${time} DESC, ${id} COLLATE "C" DESC LIMIT 1`, [clipId, this.origin]) : [];
		return { references, next: rows.length > input.limit ? references.at(-1)! : null, upper: input.upper ?? highest[0] ?? references[0] ?? null, ended: rows.length <= input.limit, revision: clip.lastClippedAt?.toISOString() ?? '' };
	}

	private async membership(viewer: MiLocalUser, options: TimelineOptions, source: 'local' | 'peer', position: Position): Promise<Page> {
		const clipIsLocal = options.clipOrigin === this.origin;
		const external = clipIsLocal ? source === 'peer' : source === 'local';
		const input: PageInput = { ...position, external, order: options.order, rangeStartAt: options.rangeStartAt, rangeEndAt: options.rangeEndAt };
		let page: Page;
		if (clipIsLocal) page = await this.peerPage(viewer, options.clipId!, input);
		else {
			const link = await this.links.privateLink(viewer.id);
			const result = await this.links.json<{ item: Page }>('/gridspace/v1/managed-resource', { kind: 'clip', action: 'note-references', id: options.clipId,
				data: input, linkId: link.id, generation: link.generation, localUserId: viewer.id, peerUserId: link.peerUserId }, true, 4 * 1024 * 1024, position.deadline);
			await this.links.checkPrivateUnchanged(link);
			page = result.item;
		}
		if (!page || !Array.isArray(page.references) || page.references.length > position.limit || typeof page.ended !== 'boolean') throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const expected = source === 'local' ? this.origin : this.peerOrigin;
		for (const ref of page.references) {
			if (!gridspaceNoteId(ref.noteId) || !/^\d{1,19}$/.test(ref.sortAt) || typeof ref.canonicalUri !== 'string' || ref.canonicalUri.length > 1024 ||
				(external && ref.canonicalUri !== expected + '/notes/' + ref.noteId)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		}
		return { ...page, references: page.references.map(ref => ({ ...ref, source })) };
	}

	public readPage(viewer: MiLocalUser, options: TimelineOptions, source: 'local' | 'peer', position: Position) {
		return this.membership(viewer, options, source, position);
	}

	public async ownerReferences(viewer: MiLocalUser, options: TimelineOptions, uris: string[]) {
		if (!uris.length) return [];
		return (await this.membership(viewer, options, 'local', { limit: 100, uris })).references;
	}

	public async hydrate(viewer: MiLocalUser, options: TimelineOptions, selected: TimelineReference[], deadline = Date.now() + 8000): Promise<(Omit<TimelineItem, 'ref' | 'key' | 'sortKey'> & { reference: TimelineReference })[]> {
		if (!selected.length) return [];
		const started = Date.now();
		const local = this.modules.get(TimelineLocalSource);
		const reader = this.modules.get(GridspacePrivateService);
		const result: (Omit<TimelineItem, 'ref' | 'key' | 'sortKey'> & { reference: TimelineReference })[] = [];
		for (const source of ['local', 'peer'] as const) {
			const wanted = selected.filter(ref => ref.source === source);
			if (!wanted.length) continue;
			if (Date.now() >= deadline) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			const page = await this.membership(viewer, options, source, { limit: 100, uris: wanted.map(ref => ref.canonicalUri), deadline });
			const allowed = wanted.filter(ref => page.references.some(row => row.canonicalUri === ref.canonicalUri && row.noteId === ref.noteId));
			if (source === 'local') {
				const rows = await local.hydrateQuery(viewer, async () => local.readableQuery(viewer), allowed);
				result.push(...rows.map(row => ({ ...row, representation: 'normal' as const })));
			} else if (options.clipOrigin !== this.origin) {
				const page = await reader.timeline(viewer, { kind: 'clip', clipId: options.clipId, ids: allowed.map(ref => ref.noteId), candidates: allowed, deadline });
				for (const note of page.notes) {
					const reference = allowed.find(ref => ref.noteId === note.id);
					if (reference) result.push({ reference, payload: note, representation: 'delegated', validForMs: page.validForMs, nextPolicyCheckAt: null });
				}
			} else {
				for (let offset = 0; offset < allowed.length; offset += 4) {
					if (Date.now() >= deadline) throw new GridspaceLinkError('PEER_UNAVAILABLE');
					await Promise.all(allowed.slice(offset, offset + 4).map(async reference => {
						const page = await reader.notes(viewer, { mode: 'show', noteId: reference.noteId, conversationUri: reference.canonicalUri }, 1, undefined, deadline).catch(error => {
							if (error instanceof GridspaceLinkError && ['ACTION_REJECTED', 'UNAVAILABLE'].includes(error.code)) return null;
							throw error;
						});
						if (!page) return;
						const note = page.notes.find(note => note.id === reference.noteId && note.uri === reference.canonicalUri);
						if (note) result.push({ reference, payload: note, representation: 'delegated', validForMs: page.validForMs, nextPolicyCheckAt: null });
					}));
				}
			}
			const fresh = await this.membership(viewer, options, source, { limit: 100, uris: wanted.map(ref => ref.canonicalUri), deadline });
			for (let i = result.length - 1; i >= 0; i--) if (result[i].reference.source === source && !fresh.references.some(ref => ref.canonicalUri === result[i].reference.canonicalUri)) result.splice(i, 1);
		}
		return result.filter(row => !options.query || options.query.trim().split(/\s+/).every(word => ((row.payload.text ?? '') + '\n' + (row.payload.cw ?? '')).toLocaleLowerCase().includes(word.toLocaleLowerCase())))
			.map(row => ({ ...row, validForMs: Math.max(0, Math.min(row.validForMs ?? TIMELINE_AUTHORIZATION_TTL_MS, TIMELINE_AUTHORIZATION_TTL_MS) - (Date.now() - started)) }))
			.filter(row => row.validForMs > 0).sort((a, b) => compareTimelinePosition(a.reference, b.reference));
	}
}
