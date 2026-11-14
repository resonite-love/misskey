/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { Brackets, type SelectQueryBuilder, type WhereExpressionBuilder } from 'typeorm';
import type { MiNote } from '@/models/Note.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { PrivatePeerRequest } from './private-protocol.js';

function fixture() {
	const query = mockDeep<SelectQueryBuilder<MiNote>>();
	for (const method of ['innerJoin', 'andWhere', 'orderBy', 'take'] as const) query[method].mockReturnValue(query);
	const noteQuery = vi.fn(() => query);
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), { search: { noteQuery, read: vi.fn(async () => []) } }) as GridspacePrivateService;
	return { service, query, noteQuery };
}

describe('linked clip search and ordering', () => {
	test.each([['newest', 'DESC', '<'], ['oldest', 'ASC', '>']] as const)('uses a bounded %s keyset and preserves clip access checks', async (order, direction, comparison) => {
		const { service, query, noteQuery } = fixture();
		await service['sourceNotes']('viewer', { mode: 'clip', clipId: 'clip', order, query: 'needle', before: 'cursor', head: 'head', rangeStartAt: 123, rangeEndAt: 456, limit: 20 } as PrivatePeerRequest);
		expect(query.orderBy).toHaveBeenCalledWith('note.id', direction);
		expect(query.andWhere).toHaveBeenCalledWith(`note.id ${comparison} :before`, { before: 'cursor' });
		expect(query.innerJoin).toHaveBeenCalledWith(expect.anything(), 'collectionOwner', expect.stringContaining('collectionOwner.userId = :collectionViewer OR collectionOwner.isPublic = true'), { collectionViewer: 'viewer' });
		expect(noteQuery).toHaveBeenCalledWith({ id: 'viewer' }, { query: '', rangeStartAt: 123, rangeEndAt: 456 }, false, true, undefined, false, true);
		expect(query.take).toHaveBeenCalledWith(21);
		if (order === 'oldest') expect(query.andWhere.mock.calls.some(([sql]) => sql === 'note.id <= :head')).toBe(false);
	});
	test('revalidation keeps the clip and search restrictions', async () => {
		const { service, query } = fixture();
		await service['sourceNotes']('viewer', { mode: 'validate', contextMode: 'clip', clipId: 'clip', order: 'oldest', query: 'needle', ids: ['one'] } as PrivatePeerRequest);
		expect(query.innerJoin).toHaveBeenCalledWith(expect.anything(), 'collection', expect.stringContaining('collection.clipId = :collectionClip'), { collectionClip: 'clip' });
		expect(query.andWhere).toHaveBeenCalledWith('note.id IN (:...ids)', { ids: ['one'] });
		expect(query.take).toHaveBeenCalledWith(100);
	});
	test('does not silently apply ascending order to other private timelines', async () => {
		const { service } = fixture();
		await expect(service['sourceNotes']('viewer', { mode: 'home', order: 'oldest' } as PrivatePeerRequest)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});

test('clip search ANDs escaped words, each matching the body or CW independently', async () => {
	const { service, query } = fixture();
	await service['sourceNotes']('viewer', { mode: 'clip', clipId: 'clip', query: 'cat dog%' } as PrivatePeerRequest);
	const clauses = query.andWhere.mock.calls.map(([clause]) => clause).filter((clause): clause is Brackets => clause instanceof Brackets);
	expect(clauses).toHaveLength(2);
	const terms = mockDeep<WhereExpressionBuilder>(); terms.where.mockReturnValue(terms); terms.orWhere.mockReturnValue(terms);
	for (const clause of clauses) clause.whereFactory(terms);
	expect(terms.where.mock.calls).toEqual([['note.text ILIKE :clipSearch0', { clipSearch0: '%cat%' }], ['note.text ILIKE :clipSearch1', { clipSearch1: '%dog\\%%' }]]);
	expect(terms.orWhere.mock.calls).toEqual([['note.cw ILIKE :clipSearch0', { clipSearch0: '%cat%' }], ['note.cw ILIKE :clipSearch1', { clipSearch1: '%dog\\%%' }]]);
});
