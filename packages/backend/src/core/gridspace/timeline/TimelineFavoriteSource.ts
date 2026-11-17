/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, type DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiNoteFavorite } from '@/models/NoteFavorite.js';
import { IdService } from '@/core/IdService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { GridspaceSearchService } from '../GridspaceSearchService.js';
import { canonicalGridspaceNoteUri, gridspaceNoteUris } from '../note-protocol.js';
import { TimelineLocalSource } from './TimelineLocalSource.js';
import type { TimelinePosition, TimelineReference } from './timeline-protocol.js';

export type FavoriteReference = TimelineReference & { sourceId: string };
type FavoritePosition = TimelinePosition & { sourceId?: string };

/** Favorites are ordered by the save event; the note ID remains body identity. */
@Injectable()
export class TimelineFavoriteSource {
	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		@Inject(DI.config) private readonly config: Config,
		private readonly ids: IdService,
		private readonly search: GridspaceSearchService,
		private readonly local: TimelineLocalSource,
	) {}

	private query(viewer: MiLocalUser) {
		if (viewer.isDeleted || viewer.isSuspended) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return this.search.noteQuery(viewer, { query: '' }, false, true, undefined, false, true)
			.innerJoin(MiNoteFavorite, 'favorite', 'favorite.noteId = note.id AND favorite.userId = :favoriteViewer', { favoriteViewer: viewer.id })
			.andWhere('EXISTS (SELECT 1 FROM "user" favorite_viewer WHERE favorite_viewer.id = :favoriteViewer AND favorite_viewer."isDeleted" = false AND favorite_viewer."isSuspended" = false)');
	}

	private reference(row: { noteId: string; uri: string | null; sourceId: string }): FavoriteReference {
		return { noteId: row.noteId, sourceId: row.sourceId,
			canonicalUri: canonicalGridspaceNoteUri(row.uri ?? `${this.config.url}/notes/${row.noteId}`, this.config.gridspace?.peerUrl),
			sortAt: (BigInt(this.ids.parse(row.sourceId).date.getTime()) * 1000n).toString(), source: 'local', normalized: true, generation: 1 };
	}

	public async read(viewer: MiLocalUser, position: { before?: FavoritePosition; upper?: FavoritePosition; untilAt?: number; limit: number }): Promise<FavoriteReference[]> {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = this.query(viewer);
		for (const [name, boundary, operator] of [['Before', position.before, '<'], ['Upper', position.upper, '<=']] as const) {
			if (!boundary) continue;
			if (!boundary.sourceId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.sourceId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere(`favorite.id ${operator} :favorite${name}`, { [`favorite${name}`]: boundary.sourceId });
		}
		if (position.untilAt != null) {
			if (!Number.isSafeInteger(position.untilAt) || position.untilAt < 0 || position.untilAt >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			query.andWhere('favorite.id < :favoriteUntil', { favoriteUntil: this.ids.gen(position.untilAt + 1) });
		}
		const rows = await query.select('note.id', 'noteId').addSelect('note.uri', 'uri').addSelect('favorite.id', 'sourceId')
			.orderBy('favorite.id', 'DESC').limit(position.limit).getRawMany<{ noteId: string; uri: string | null; sourceId: string }>();
		return rows.map(row => this.reference(row));
	}

	public async hydrate(viewer: MiLocalUser, references: FavoriteReference[]) {
		if (references.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if (!references.length) return [];
		const current = await this.query(viewer).andWhere('favorite.id IN (:...favoriteIds)', { favoriteIds: references.map(ref => ref.sourceId) })
			.select('note.id', 'noteId').addSelect('note.uri', 'uri').addSelect('favorite.id', 'sourceId').getRawMany<{ noteId: string; uri: string | null; sourceId: string }>();
		const valid = new Map(current.map(row => [row.sourceId, this.reference(row)]));
		const selected = references.filter(ref => { const saved = valid.get(ref.sourceId); return saved?.noteId === ref.noteId && saved.canonicalUri === ref.canonicalUri; });
		const bodies = await this.local.hydrateQuery(viewer, async () => this.query(viewer), selected);
		// Unfavorite/resave during body packing invalidates the old reference even
		// when the same note remains in the current favorites list.
		const fresh = await this.db.getRepository(MiNoteFavorite).find({ where: { userId: viewer.id, id: In(selected.map(ref => ref.sourceId)) } });
		const saved = new Map(fresh.map(row => [row.id, row.noteId]));
		return bodies.filter(row => saved.get((row.reference as FavoriteReference).sourceId) === row.reference.noteId)
			.map(row => ({ ...row, payload: { ...row.payload, collectionAt: this.ids.parse((row.reference as FavoriteReference).sourceId).date.toISOString() } }));
	}

	public async readPage(viewer: MiLocalUser, position: { before?: FavoritePosition; upper?: FavoritePosition; untilAt?: number; limit: number }) {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 50) throw new GridspaceLinkError('INVALID_REQUEST');
		const scan = this.db.getRepository(MiNoteFavorite).createQueryBuilder('candidate').where('candidate.userId = :favoriteViewer', { favoriteViewer: viewer.id });
		for (const [name, boundary, operator] of [['Before', position.before, '<'], ['Upper', position.upper, '<=']] as const) {
			if (!boundary) continue;
			if (!boundary.sourceId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.sourceId)) throw new GridspaceLinkError('INVALID_CURSOR');
			scan.andWhere(`candidate.id ${operator} :favorite${name}`, { [`favorite${name}`]: boundary.sourceId });
		}
		if (position.untilAt != null) scan.andWhere('candidate.id < :favoriteUntil', { favoriteUntil: this.ids.gen(position.untilAt + 1) });
		const rows = await scan.orderBy('candidate.id', 'DESC').limit(513).getMany();
		const window = rows.slice(0, 512);
		const boundary = (favorite: MiNoteFavorite): FavoriteReference => this.reference({ noteId: favorite.noteId, sourceId: favorite.id, uri: null });
		const upper = position.upper ?? (window[0] ? boundary(window[0]) : null);
		if (!window.length) return { references: [], next: null, upper, ended: true };
		const readable = await this.query(viewer).andWhere('favorite.id IN (:...favoriteWindow)', { favoriteWindow: window.map(row => row.id) })
			.select('note.id', 'noteId').addSelect('note.uri', 'uri').addSelect('favorite.id', 'sourceId').orderBy('favorite.id', 'DESC').limit(position.limit + 1)
			.getRawMany<{ noteId: string; uri: string | null; sourceId: string }>();
		const references = readable.slice(0, position.limit).map(row => this.reference(row));
		const more = readable.length > position.limit || rows.length > 512;
		return { references, next: more ? readable.length > position.limit ? references.at(-1)! : boundary(window.at(-1)!) : null, upper, ended: !more };
	}

	public async ownerReferences(viewer: MiLocalUser, uris: string[], upper?: FavoritePosition | null): Promise<FavoriteReference[]> {
		return (await this.hydrate(viewer, await this.ownerCandidates(viewer, uris, upper))).map(row => row.reference as FavoriteReference);
	}

	/** Current root ACL and save identity, without constructing display bodies. */
	public async ownerCandidates(viewer: MiLocalUser, uris: string[], upper?: FavoritePosition | null): Promise<FavoriteReference[]> {
		if (uris.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if (!uris.length || upper === null) return [];
		const aliases = [...new Set(uris.flatMap(uri => gridspaceNoteUris(uri, this.config.gridspace?.peerUrl)))];
		const prefix = `${this.config.url}/notes/`;
		const ids = uris.filter(uri => uri.startsWith(prefix)).map(uri => uri.slice(prefix.length)).filter(id => /^[a-zA-Z0-9]{1,32}$/.test(id));
		const query = this.query(viewer).andWhere(`(note.uri IN (:...favoriteUris)${ids.length ? ' OR note.id IN (:...favoriteNoteIds)' : ''})`, { favoriteUris: aliases, favoriteNoteIds: ids });
		if (upper) {
			if (!upper.sourceId || !/^[a-zA-Z0-9]{1,32}$/.test(upper.sourceId)) throw new GridspaceLinkError('INVALID_CURSOR');
			query.andWhere('favorite.id <= :favoriteUpper', { favoriteUpper: upper.sourceId });
		}
		const rows = await query.select('note.id', 'noteId').addSelect('note.uri', 'uri').addSelect('favorite.id', 'sourceId').limit(100).getRawMany<{ noteId: string; uri: string | null; sourceId: string }>();
		const wanted = new Set(uris);
		return rows.map(row => this.reference(row)).filter(ref => wanted.has(ref.canonicalUri));
	}
}
