/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import type { IdService } from '@/core/IdService.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspaceSearchService } from '../GridspaceSearchService.js';
import type { TimelineLocalSource } from './TimelineLocalSource.js';
import { TimelineFavoriteSource, type FavoriteReference } from './TimelineFavoriteSource.js';

const viewer = { id: 'viewer' } as MiLocalUser;
const reference: FavoriteReference = { noteId: 'oldNote', sourceId: 'newSave', canonicalUri: 'https://local.test/notes/oldNote', sortAt: '2000000', normalized: true, generation: 1, source: 'local' };

function fixture() {
	const query = {
		innerJoin: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
		addSelect: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
		getRawMany: vi.fn().mockResolvedValue([{ noteId: 'oldNote', sourceId: 'newSave', uri: null }]),
	};
	const find = vi.fn().mockResolvedValue([{ id: 'newSave', noteId: 'oldNote' }]);
	const hydrateQuery = vi.fn(async (_viewer, factory, references) => { await factory(); return references.map((ref: FavoriteReference) => ({ reference: ref, payload: { id: ref.noteId }, validForMs: null })); });
	const source = new TimelineFavoriteSource({ getRepository: () => ({ find }) } as unknown as DataSource,
		{ url: 'https://local.test' } as Config, { parse: (id: string) => ({ date: new Date(id === 'newSave' ? 2000 : 1000) }), gen: (at: number) => `id${at}` } as unknown as IdService,
		{ noteQuery: () => query } as unknown as GridspaceSearchService, { hydrateQuery } as unknown as TimelineLocalSource);
	return { source, query, find, hydrateQuery };
}

describe('saved-at favorite source', () => {
	test('pages by the collection id while keeping note identity independent', async () => {
		const { source, query } = fixture();
		const before = { ...reference, sourceId: 'saveBoundary' };
		const rows = await source.read(viewer, { before, limit: 20 });
		expect(rows).toEqual([reference]);
		expect(query.andWhere).toHaveBeenCalledWith('favorite.id < :favoriteBefore', { favoriteBefore: 'saveBoundary' });
		expect(query.orderBy).toHaveBeenCalledWith('favorite.id', 'DESC');
		expect(query.andWhere.mock.calls.some(([sql]) => sql.startsWith('note.id <'))).toBe(false);
	});
	test('hydrates saved-at display metadata only after current favorite membership passes', async () => {
		const { source, find } = fixture();
		const rows = await source.hydrate(viewer, [reference]);
		expect(rows[0].payload).toMatchObject({ id: 'oldNote', collectionAt: new Date(2000).toISOString() });
		expect(find).toHaveBeenCalledWith({ where: { userId: 'viewer', id: expect.anything() } });
	});
	test('unfavorite/resave during body hydration cannot revive the old save event', async () => {
		const { source, find } = fixture();
		find.mockResolvedValue([{ id: 'differentSave', noteId: 'oldNote' }]);
		expect(await source.hydrate(viewer, [reference])).toEqual([]);
	});
	test('rejects an ID-only note cursor in place of a favorite cursor', async () => {
		const { source, query } = fixture();
		await expect(source.read(viewer, { before: { noteId: 'oldNote', sortAt: '1', canonicalUri: reference.canonicalUri }, limit: 20 })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
		expect(query.getRawMany).not.toHaveBeenCalled();
	});
	test('a note cached locally does not own a peer favorite without an allowed current local save', async () => {
		const { source, find, hydrateQuery } = fixture(); find.mockResolvedValue([]);
		expect(await source.ownerReferences(viewer, [reference.canonicalUri], reference)).toEqual([]);
		expect(hydrateQuery).toHaveBeenCalled();
	});
});
