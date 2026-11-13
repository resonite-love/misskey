/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import type { IdService } from '@/core/IdService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import type { MetaService } from '@/core/MetaService.js';
import type { PageEntityService } from '@/core/entities/PageEntityService.js';
import type { GalleryPostEntityService } from '@/core/entities/GalleryPostEntityService.js';
import { GridspaceContentService } from './GridspaceContentService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceHistoryService } from './GridspaceHistoryService.js';

function fixture() {
	const db = mockDeep<DataSource>();
	const links = mockDeep<GridspaceLinkService>(), history = mockDeep<GridspaceHistoryService>();
	const pages = mockDeep<PageEntityService>(), gallery = mockDeep<GalleryPostEntityService>(), meta = mockDeep<MetaService>();
	const config = { url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example' } } as Config;
	meta.fetch.mockResolvedValue({ ugcVisibilityForVisitor: 'all' } as never);
	db.getRepository.mockReturnValue({ findBy: async () => [] } as never);
	const service = new GridspaceContentService(db, config, pages, gallery, links, history, meta, mockDeep<IdService>(), mockDeep<CustomEmojiService>());
	return { service, db, config, links, history, pages, gallery, meta };
}

describe('public linked pages and gallery', () => {
	test('disabled bridge and hidden visitor UGC do not request the peer', async () => {
		const f = fixture(); f.config.gridspace!.enabled = false;
		expect((await f.service.list({ kind: 'pages' }, true)).pages).toEqual([]);
		f.config.gridspace!.enabled = true; f.meta.fetch.mockResolvedValue({ ugcVisibilityForVisitor: 'local' } as never);
		expect((await f.service.list({ kind: 'gallery' }, false)).gallery).toEqual([]);
		expect(f.links.json).not.toHaveBeenCalled();
	});
	test('marks the source and prevents native user ID collisions without extra federation lookups', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ origin: 'https://r.example', pages: [{ id: 'page1', attachedFiles: [], eyeCatchingImage: null, userId: 'owner', user: { id: 'owner', username: 'name', host: null } }], gallery: [], next: null });
		const result = await f.service.list({ kind: 'pages', itemId: 'page1' }, true);
		expect(result.pages[0]).toMatchObject({ gridspaceOrigin: 'https://r.example', userId: 'gridspace:owner', user: { host: 'r.example', id: 'gridspace:owner' } });
	});
	test('rejects a response from an unexpected origin or a forwarded remote author', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ origin: 'https://other.example', pages: [], gallery: [] });
		await expect(f.service.list({ kind: 'pages' }, true)).rejects.toThrow('PEER_UNAVAILABLE');
		f.links.json.mockResolvedValue({ origin: 'https://r.example', pages: [{ id: 'a', userId: 'b', user: { host: 'other.example' } }], gallery: [] });
		await expect(f.service.list({ kind: 'pages' }, true)).rejects.toThrow('PEER_UNAVAILABLE');
	});
	test('limits detail to one row and excludes private pages and suspended authors in the source query', async () => {
		const f = fixture(); const query = { innerJoin: vi.fn(), where: vi.fn(), andWhere: vi.fn(), orderBy: vi.fn(), addOrderBy: vi.fn(), take: vi.fn(), getMany: vi.fn().mockResolvedValue([]) };
		for (const key of ['innerJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'take'] as const) query[key].mockReturnValue(query);
		f.db.getRepository.mockReturnValue({ createQueryBuilder: () => query } as never);
		f.pages.packMany.mockResolvedValue([]);
		await f.service.peer({ kind: 'pages', itemId: 'secret', limit: 20 });
		expect(query.where).toHaveBeenCalledWith(expect.stringContaining('author.isSuspended = false'));
		expect(query.andWhere).toHaveBeenCalledWith('item.visibility = :visibility', { visibility: 'public' });
		expect(query.andWhere).toHaveBeenCalledWith('item.id = :itemId', { itemId: 'secret' });
		expect(query.take).toHaveBeenCalledWith(2);
	});
	test('unknown profile IDs do not fall back to the global list', async () => {
		const f = fixture(); f.db.getRepository.mockReturnValue({ findOneBy: async () => null } as never);
		expect((await f.service.list({ kind: 'pages', userId: 'missing' }, true)).pages).toEqual([]);
		expect(f.links.json).not.toHaveBeenCalled();
	});
	test.each([
		{ input: { itemId: 'expected' }, ids: ['wrong'], next: null },
		{ input: { before: 'm' }, ids: ['z'], next: null },
		{ input: { after: 'm' }, ids: ['a'], next: null },
		{ input: {}, ids: ['b', 'c'], next: null },
		{ input: { after: 'a' }, ids: ['c', 'b'], next: null },
		{ input: {}, ids: ['c', 'b'], next: 'c' },
	])('rejects invalid detail or nonadvancing cursors: %j', async ({ input, ids, next }) => {
		const f = fixture();
		f.links.json.mockResolvedValue({ origin: 'https://r.example', pages: ids.map(id => ({ id, userId: 'owner', user: { host: null } })), gallery: [], next });
		await expect(f.service.list({ kind: 'pages', ...input }, true)).rejects.toThrow('PEER_UNAVAILABLE');
	});
	test('rejects an unexpected content kind, and accepts both ordered keysets', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ origin: 'https://r.example', pages: [], gallery: [{ id: 'a' }], next: null });
		await expect(f.service.list({ kind: 'pages' }, true)).rejects.toThrow('PEER_UNAVAILABLE');
		for (const [ids, options] of [[['c', 'b'], { before: 'd' }], [['b', 'c'], { after: 'a' }]] as const) {
			f.links.json.mockImplementation(async () => ({ origin: 'https://r.example', pages: ids.map(id => ({ id, attachedFiles: [], eyeCatchingImage: null, userId: 'owner', user: { id: 'owner', host: null } })), gallery: [], next: ids.at(-1) }) as never);
			expect((await f.service.list({ kind: 'pages', ...options }, true)).pages.map(page => page.id)).toEqual(ids);
		}
	});
});
