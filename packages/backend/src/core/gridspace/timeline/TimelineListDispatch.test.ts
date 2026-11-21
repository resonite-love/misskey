/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import { GridspacePrivateService } from '../GridspacePrivateService.js';
import { GridspaceTimelineService } from './GridspaceTimelineService.js';

const viewer = { id: 'viewer' } as MiLocalUser;

describe('list timeline dispatch preserves scope', () => {
	test.each(['mentions', 'direct'] as const)('%s uses its local adapter and not the home subscription', async kind => {
		const lists = { readPage: vi.fn(async () => ({ references: [], next: null, upper: null, ended: true })), hydrate: vi.fn(async () => []), ownerReferences: vi.fn(async () => []) };
		const home = { readPage: vi.fn(), hydrate: vi.fn(), ownerReferences: vi.fn() };
		const service = Object.assign(Object.create(GridspaceTimelineService.prototype), { lists, local: home }) as GridspaceTimelineService;
		const adapter = service['localSource']({ kind });
		await adapter.readPage(viewer, { limit: 20 }); await adapter.hydrate(viewer, []); await adapter.ownerReferences(viewer, []);
		expect(lists.readPage).toHaveBeenCalledWith(viewer, { kind }, { limit: 20 });
		expect(home.readPage).not.toHaveBeenCalled(); expect(home.hydrate).not.toHaveBeenCalled();
	});
	test('channel-only lists have no local normal cache source', async () => {
		const local = { readPage: vi.fn(), hydrate: vi.fn() };
		const service = Object.assign(Object.create(GridspaceTimelineService.prototype), { local }) as GridspaceTimelineService;
		const adapter = service['localSource']({ kind: 'channel', channelId: 'channel' });
		expect(await adapter.readPage(viewer, { limit: 20 })).toMatchObject({ references: [], ended: true });
		expect(await adapter.hydrate(viewer, [])).toEqual([]);
		expect(local.readPage).not.toHaveBeenCalled();
	});
	test.each(['mentions', 'direct'] as const)('a G-only channel credential cannot authorize %s', async kind => {
		const privateLink = vi.fn(async () => { throw new Error('No old-account grant'); });
		const destination = vi.fn();
		const service = Object.assign(Object.create(GridspacePrivateService.prototype), { db: { getRepository: () => ({ existsBy: async () => true }) }, links: { privateLink }, channelAuth: { isClient: true, destination } }) as GridspacePrivateService;
		await expect(service.timeline(viewer, { kind })).rejects.toThrow('No old-account grant');
		expect(destination).not.toHaveBeenCalled();
	});
	test('channel and filter combinations are rejected before any credential is selected', async () => {
		const destination = vi.fn();
		const service = Object.assign(Object.create(GridspacePrivateService.prototype), { db: { getRepository: () => ({ existsBy: async () => true }) }, channelAuth: { isClient: true, destination } }) as GridspacePrivateService;
		await expect(service.timeline(viewer, { kind: 'channel' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(service.timeline(viewer, { kind: 'direct', channelId: 'channel' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(destination).not.toHaveBeenCalled();
	});
	test('a suspended or deleted local viewer cannot enter the public-without-grant path', async () => {
		const privateLink = vi.fn();
		const service = Object.assign(Object.create(GridspacePrivateService.prototype), { db: { getRepository: () => ({ existsBy: async () => false }) }, links: { privateLink } }) as GridspacePrivateService;
		await expect(service.timeline(viewer, { kind: 'search', query: 'public' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(privateLink).not.toHaveBeenCalled();
	});
	test.each([false, true])('the feature capability enumerates the accepted list adapters with channel placements=%s', async channelPlacements => {
		const service = Object.assign(Object.create(GridspaceTimelineService.prototype), { enabled: true, peer: {}, placements: { supportHome: async () => channelPlacements } }) as GridspaceTimelineService;
		expect(await service.capability()).toEqual({ enabled: true, version: 1, channelPlacements, kinds: ['home', 'social', 'profile', 'search', 'mentions', 'direct', 'favorites', 'channel', 'antenna', 'clip'] });
	});
});
