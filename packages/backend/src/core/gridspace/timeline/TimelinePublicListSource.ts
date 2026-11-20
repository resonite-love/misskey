/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { type DataSource, type SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiUser } from '@/models/User.js';
import { RoleService } from '@/core/RoleService.js';
import { IdService } from '@/core/IdService.js';
import { GridspaceSearchService } from '../GridspaceSearchService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { canonicalGridspaceNoteUri } from '../note-protocol.js';
import type { TimelinePosition, TimelineReference } from './timeline-protocol.js';

export type PublicListRequest = {
	kind: 'profile' | 'search'; viewerId?: string; targetUris?: string[];
	query?: string; rangeStartAt?: number; rangeEndAt?: number;
	withReplies?: boolean; withRenotes?: boolean; withFiles?: boolean;
};

/** The public arm of a peer list; it never accepts delegated account credentials. */
@Injectable()
export class TimelinePublicListSource {
	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		@Inject(DI.config) private readonly config: Config,
		private readonly roles: RoleService,
		private readonly search: GridspaceSearchService,
		private readonly ids: IdService,
	) {}

	public async buildQuery(input: PublicListRequest, boundedSearch = false): Promise<SelectQueryBuilder<MiNote>> {
		if (!this.config.gridspace?.enabled) throw new GridspaceLinkError('UNAVAILABLE');
		if (input.kind === 'profile' && !input.targetUris?.length) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.targetUris && (input.targetUris.length > 4 || input.targetUris.some(uri => !/^https:\/\//.test(uri)))) throw new GridspaceLinkError('INVALID_REQUEST');
		const viewer = input.viewerId ? await this.db.getRepository(MiUser).findOneBy({ uri: `${new URL(this.config.gridspace.peerUrl).origin}/users/${input.viewerId}` }) : null;
		if (viewer?.isDeleted || viewer?.isSuspended) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (input.kind === 'search' && (!input.query?.trim() || input.query.length > 200 || !(await this.roles.getUserPolicies(viewer?.id ?? null)).canSearchNotes)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		// source=true requires local authors, public/home, no channel and temporal
		// author policies suitable for public import. A signed viewer assertion
		// authenticates the visitor even if its actor is not cached here yet.
		const query = this.search.noteQuery(viewer, {
			query: input.kind === 'search' ? input.query!.trim() : '', rangeStartAt: input.rangeStartAt, rangeEndAt: input.rangeEndAt,
		}, true, input.viewerId != null, undefined, (boundedSearch && input.kind === 'search') || !!input.targetUris?.length);
		if (input.targetUris) query.andWhere("(:publicListOrigin || '/users/' || note.userId) IN (:...publicListTargets)", { publicListOrigin: this.config.url, publicListTargets: input.targetUris });
		if (input.kind === 'profile') {
			if (!input.withReplies) query.andWhere('note.replyId IS NULL');
			if (input.withRenotes === false) query.andWhere("((note.renoteId IS NULL AND note.gridspaceQuote IS NULL) OR note.text IS NOT NULL OR note.fileIds != '{}' OR note.hasPoll = true)");
			if (input.withFiles) query.andWhere("note.fileIds != '{}'");
		}
		return query;
	}

	public async readPage(input: PublicListRequest, position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; limit: number }) {
		if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 50) throw new GridspaceLinkError('INVALID_REQUEST');
		const query = await this.buildQuery(input, true);
		const windowSize = input.kind === 'search' ? 4096 : 512;
		const scan = this.db.getRepository(MiNote).createQueryBuilder('candidate').select(['candidate.id', 'candidate.uri']);
		for (const [name, boundary, operator] of [['Before', position.before, '<'], ['Upper', position.upper, '<=']] as const) {
			if (!boundary) continue;
			if (!boundary.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
			scan.andWhere(`candidate.id ${operator} :publicList${name}`, { [`publicList${name}`]: boundary.noteId });
		}
		if (position.untilAt != null) {
			if (!Number.isSafeInteger(position.untilAt) || position.untilAt < 0 || position.untilAt >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
			scan.andWhere('candidate.id < :publicListUntil', { publicListUntil: this.ids.gen(position.untilAt + 1) });
		}
		const candidates = await scan.orderBy('candidate.id', 'DESC').limit(windowSize + 1).getMany();
		const window = candidates.slice(0, windowSize);
		const upper = position.upper ?? (window[0] ? this.reference(window[0]) : null);
		if (!window.length) return { references: [], next: null, upper, ended: true };
		const rows = await this.search.read(query.andWhere('note.id IN (:...publicListWindow)', { publicListWindow: window.map(note => note.id) }).orderBy('note.id', 'DESC').limit(position.limit + 1));
		const references = rows.slice(0, position.limit).map(note => this.reference(note));
		const more = rows.length > position.limit || candidates.length > windowSize;
		return { references, next: more ? rows.length > position.limit ? references.at(-1)! : this.reference(window.at(-1)!) : null, upper, ended: !more };
	}

	/** Recheck only requested IDs; the caller must still apply destination ACL after import. */
	public async validate(input: PublicListRequest, ids: string[]): Promise<TimelineReference[]> {
		if (ids.length > 100 || ids.some(id => !/^[a-zA-Z0-9]{1,32}$/.test(id))) throw new GridspaceLinkError('INVALID_REQUEST');
		if (!ids.length) return [];
		const query = await this.buildQuery(input, true);
		const rows = await this.search.read(query.andWhere('note.id IN (:...publicListIds)', { publicListIds: ids }).limit(100));
		return rows.map(note => this.reference(note));
	}

	private reference(note: Pick<MiNote, 'id' | 'uri'>): TimelineReference {
		return { noteId: note.id, canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.config.url}/notes/${note.id}`, this.config.gridspace?.peerUrl),
			sortAt: (BigInt(this.ids.parse(note.id).date.getTime()) * 1000n).toString(), source: 'peer', normalized: true, generation: 1 };
	}
}
