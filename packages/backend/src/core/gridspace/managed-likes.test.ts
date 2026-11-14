/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { MiUser } from '@/models/User.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiPage } from '@/models/Page.js';
import { MiGalleryPost } from '@/models/GalleryPost.js';
import { MiPageLike } from '@/models/PageLike.js';
import { MiGalleryLike } from '@/models/GalleryLike.js';
import { MiFollowing } from '@/models/Following.js';
import { MiBlocking } from '@/models/Blocking.js';
import { IdService } from '@/core/IdService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { GridspaceManagedResourceService } from './GridspaceManagedResourceService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceSharedDriveService } from './GridspaceSharedDriveService.js';

function fixture() {
	const db = mockDeep<DataSource>(), modules = mockDeep<ModuleRef>();
	const state = { active: true, visible: true, following: false, blocked: false, visibility: 'public', writes: [] as string[] };
	const row = { id: 'page', userId: 'author', visibility: 'public', visibleUserIds: ['viewer'] };
	const query = { where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(), getMany: vi.fn(async () => [{ id: 'like1', pageId: 'page', postId: 'page' }, { id: 'like2', pageId: 'page', postId: 'page' }]) };
	db.getRepository.mockImplementation(entity => {
		if (entity === MiUser) return { existsBy: async () => state.visible, findOneByOrFail: async () => ({ id: 'viewer' }) } as never;
		if (entity === MiGridspaceLink) return { findOneBy: async () => state.active ? { id: 'link', generation: 1, peerUserId: 'peer', localUserId: 'viewer' } : null } as never;
		if (entity === MiPage || entity === MiGalleryPost) return { findOneBy: async () => ({ ...row, visibility: state.visibility }) } as never;
		if (entity === MiFollowing) return { existsBy: async () => state.following } as never;
		if (entity === MiBlocking) return { existsBy: async () => state.blocked } as never;
		if (entity === MiPageLike || entity === MiGalleryLike) return { createQueryBuilder: () => query } as never;
		throw new Error('Unexpected repository');
	});
	modules.get.mockImplementation((key: unknown) => {
		if (key === IdService) return { parse: () => ({ date: new Date('2026-11-14') }) } as never;
		return { exec: async () => {
			state.writes.push(String(key));
			return { id: 'page', userId: 'author', user: { name: 'Author', username: 'author', emojis: {} }, content: [] };
		} } as never;
	});
	const emojis = mockDeep<CustomEmojiService>(); emojis.populateEmojis.mockResolvedValue({}); emojis.localEmojisCache.fetch.mockResolvedValue(new Map());
	const service = new GridspaceManagedResourceService(db, { url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example' } } as Config, modules, mockDeep<GridspaceLinkService>(), mockDeep<GridspaceSharedDriveService>(), mockDeep<GlobalEventService>(), emojis);
	const call = (action: 'liked' | 'inspect' | 'like' | 'unlike', kind: 'page' | 'gallery' = 'page', data?: Record<string, unknown>) => service.peer({ kind, action, id: 'page', data, linkId: 'link', generation: 1, localUserId: 'peer', peerUserId: 'viewer' });
	return { state, query, call };
}

describe('shared Page and Gallery likes', () => {
	test.each(['page', 'gallery'] as const)('paginates %s likes by like ID and keeps the source timestamp', async kind => {
		const f = fixture(); const result = await f.call('liked', kind, { limit: 1, before: 'cursor' });
		expect(result.next).toBe('like1');
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ gridspaceLikeId: 'like1', gridspaceLikedAt: '2026-11-14T00:00:00.000Z' });
		expect(f.query.where).toHaveBeenCalledWith('liked.userId = :id', { id: 'viewer' });
	});
	test('does not reveal a page after follow permission is lost or the author blocks the viewer', async () => {
		const f = fixture(); f.state.visibility = 'followers';
		expect((await f.call('liked')).items).toEqual([]);
		await expect(f.call('inspect')).rejects.toThrow();
		f.state.following = true; expect((await f.call('liked')).items).toHaveLength(2);
		f.state.blocked = true; expect((await f.call('liked')).items).toEqual([]);
	});
	test('allows unliking a now unreadable page without returning its content', async () => {
		const f = fixture(); f.state.blocked = true;
		expect((await f.call('unlike')).item).toBeNull();
		expect(f.state.writes).toEqual(['ep:pages/unlike']);
	});
	test('rejects invalid cursor and revoked pair', async () => {
		const f = fixture(); await expect(f.call('liked', 'page', { before: 'bad/url' })).rejects.toThrow();
		f.state.active = false; await expect(f.call('liked')).rejects.toThrow();
		expect(f.state.writes).toEqual([]);
	});
});
