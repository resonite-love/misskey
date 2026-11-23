/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { SelectQueryBuilder } from 'typeorm';
import { MiNote } from '@/models/Note.js';
import type { IdService } from '@/core/IdService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import type { GridspaceSearchService } from '../GridspaceSearchService.js';
import type { TimelinePosition } from './timeline-protocol.js';

/** Page the already-authorized matches, not windows of unrelated note IDs. */
export async function readSearchRows(search: Pick<GridspaceSearchService, 'read' | 'readAuthorPage'>, query: SelectQueryBuilder<MiNote>, ids: Pick<IdService, 'gen'>,
	position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; fromAt?: number; limit: number }, authorIds?: string[]): Promise<MiNote[]> {
	if (!Number.isInteger(position.limit) || position.limit < 1 || position.limit > 50) throw new GridspaceLinkError('INVALID_REQUEST');
	const page = query.clone().select(['note.id', 'note.uri']);
	const parameters = page.getParameters();
	if (!authorIds?.length && parameters.gridspaceAuthorScoped !== true && typeof parameters.q === 'string') {
		// Keep text matching ahead of the ACL joins. PGroonga's cardinality
		// estimate can otherwise repeat the text scan for every user.
		// OFFSET 0 is a streaming planner boundary, not a result limit.
		const matches = page.connection.createQueryBuilder().select('candidate.*').from(MiNote, 'candidate')
			.where('(candidate.text ILIKE :q OR (candidate.cw IS NOT NULL AND candidate.cw::text ILIKE :q))');
		// Retain entity metadata for hydration and all original ACL predicates.
		page.expressionMap.mainAlias!.subQuery = `(${matches.getQuery()} OFFSET 0)`;
	}
	for (const [name, boundary, operator] of [['Before', position.before, '<'], ['Upper', position.upper, '<=']] as const) {
		if (!boundary) continue;
		if (!boundary.noteId || !/^[a-zA-Z0-9]{1,32}$/.test(boundary.noteId)) throw new GridspaceLinkError('INVALID_CURSOR');
		page.andWhere(`note.id ${operator} :search${name}`, { [`search${name}`]: boundary.noteId });
	}
	for (const [name, time, operator, offset] of [['Until', position.untilAt, '<', 1], ['From', position.fromAt, '>', -1]] as const) {
		if (time == null) continue;
		if (!Number.isSafeInteger(time) || time < 0 || time >= 4102444800000) throw new GridspaceLinkError('INVALID_REQUEST');
		page.andWhere(`note.id ${operator} :search${name}`, { [`search${name}`]: ids.gen(Math.max(0, time + offset)) });
	}
	// CONCAT prevents a rare text match from choosing an ordered primary-key
	// scan through the whole table. Explicit authors retain their (userId, id) index.
	page.orderBy(authorIds?.length ? 'note.id' : 'CONCAT(note.id)', 'DESC').limit(position.limit + 1);
	return authorIds?.length ? search.readAuthorPage(page, authorIds, position.limit + 1) : search.read(page);
}
