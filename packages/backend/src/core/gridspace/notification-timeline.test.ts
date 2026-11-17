/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { MiLocalUser } from '@/models/User.js';
import { meta, paramDef } from '@/server/api/endpoints/gridspace/notifications/timeline.js';
import { GridspaceLinkError } from './GridspaceLinkService.js';
import { GridspaceNotificationTimelineService } from './GridspaceNotificationTimelineService.js';
import type { Redis } from 'ioredis';
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceNotificationService } from './GridspaceNotificationService.js';

const at = (time: number) => new Date(1700000000000 + time).toISOString();

function fixture() {
	const redis = mockDeep<Redis>(); const stored = new Map<string, string>();
	redis.eval.mockImplementation(async (_script, _num, key, _user, value) => { stored.set(String(key), String(value)); return 1; });
	redis.get.mockImplementation(async key => stored.get(key) ?? null);
	const notifications = mockDeep<GridspaceNotificationService>();
	const links = mockDeep<GridspaceLinkService>();
	const channels = mockDeep<GridspaceChannelAuthService>();
	links.privateLink.mockResolvedValue({ id: 'link', generation: 1, privateRevision: 1, privateTokenCipher: 'secret', peerOrigin: 'https://peer', peerUserId: 'old' } as never);
	const reference = (id: string, time: number) => ({ id, createdAt: at(time) });
	const localRefs = [reference('same', 4), reference('l2', 1)];
	const peerRefs = [reference('p1', 5), reference('same', 3), reference('p2', 2)];
	notifications.localReferences.mockResolvedValue({ origin: 'https://local', recipientId: 'viewer', items: localRefs, complete: true });
	notifications.remoteReferences.mockResolvedValue({ origin: 'https://peer', recipientId: 'old', items: peerRefs, complete: true });
	const page = (refs: typeof localRefs, input: { ids?: string[] }, origin: string, recipientId: string, local = false) => ({
		origin, recipientId, items: refs.filter(ref => input.ids?.includes(ref.id)).map(ref => ({ ...ref, isRead: false, ...(local ? { notification: { id: ref.id, type: 'test', createdAt: ref.createdAt } } : { type: 'test', body: 'private body', user: null, note: null, reaction: null }) })), unreadCount: 3, next: null, newest: null, boundary: null,
	});
	notifications.local.mockImplementation(async (_user, input) => page(localRefs, input, 'https://local', 'viewer', true) as never);
	notifications.remote.mockImplementation(async (_user, input) => page(peerRefs, input, 'https://peer', 'old') as never);
	const service = new GridspaceNotificationTimelineService(redis, notifications, links, channels);
	return { redis, stored, notifications, links, channels, localRefs, peerRefs, service, user: { id: 'viewer' } as MiLocalUser };
}

describe('notification timeline snapshots', () => {
	test('allows bounded client retention only for a transport failure with the same binding', async () => {
		const f = fixture(); const first = await f.service.read(f.user, { limit: 4 });
		f.notifications.remoteReferences.mockRejectedValue(new GridspaceLinkError('PEER_UNAVAILABLE', true));
		const failed = await f.service.read(f.user, { mode: 'refresh', cursor: first.cursor, count: 4 });
		expect(failed.sources.find(source => source.source === 'peer')).toMatchObject({ status: 'unavailable', retryable: true });
		expect(failed.items.every(item => item.source === 'local')).toBe(true);
		f.links.privateLink.mockResolvedValue({ id: 'rotated', generation: 2, privateTokenCipher: 'new' } as never);
		const rotated = await f.service.read(f.user, { mode: 'validate', cursor: failed.cursor, count: 4 });
		expect(rotated.sources.find(source => source.source === 'peer')?.retryable).toBe(false);
	});
	test('does not classify malformed responses as retryable or return partially read bodies', async () => {
		const f = fixture(); const first = await f.service.read(f.user, { limit: 4 });
		f.notifications.remote.mockRejectedValue(new GridspaceLinkError('PEER_UNAVAILABLE'));
		const invalid = await f.service.read(f.user, { mode: 'validate', cursor: first.cursor, count: 4 });
		expect(invalid.sources.find(source => source.source === 'peer')).toMatchObject({ status: 'unavailable', retryable: false });
		expect(invalid.items.every(item => item.source === 'local')).toBe(true);
	});
	test('orders all sources on server, keeps equal IDs distinct and stores references only', async () => {
		const f = fixture();
		const first = await f.service.read(f.user, { limit: 2 });
		expect(first.items.map(item => item.id)).toEqual(['p1', 'same']);
		const rest = await f.service.read(f.user, { cursor: first.nextCursor! });
		expect(rest.items.map(item => item.id)).toEqual(['same', 'p2']);
		expect(new Set([...first.items, ...rest.items].map(item => item.key)).size).toBe(4);
		expect([...f.stored.values()].join('')).not.toContain('private body');
		expect(f.notifications.remote.mock.calls.every(call => !call[2] || call[2] === 'query')).toBe(true);
	});

	test('replays concurrently without moving the boundary and rechecks bodies/read flags', async () => {
		const f = fixture(); const first = await f.service.read(f.user, { limit: 2 });
		const [a, b] = await Promise.all([f.service.read(f.user, { cursor: first.nextCursor! }), f.service.read(f.user, { cursor: first.nextCursor! })]);
		expect(a.nextCursor).toBe(b.nextCursor); expect(a.items).toEqual(b.items);
		f.peerRefs.splice(1, 1);
		const deleted = await f.service.read(f.user, { cursor: first.nextCursor! });
		expect(deleted.items.map(item => item.id)).toEqual(['p2']); expect(deleted.nextCursor).toBe(a.nextCursor);
		expect(deleted.scannedCount).toBe(4);
	});

	test('rejects altered cursor, viewer and filters; expiry asks for a restart', async () => {
		const f = fixture(); const first = await f.service.read(f.user, { excludeTypes: ['reaction'] });
		await expect(f.service.read({ id: 'other' } as MiLocalUser, { cursor: first.cursor, excludeTypes: ['reaction'] })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
		await expect(f.service.read(f.user, { cursor: first.cursor })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
		await expect(f.service.read(f.user, { cursor: first.cursor.replace(/.$/, first.cursor.endsWith('0') ? '1' : '0'), excludeTypes: ['reaction'] })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
		expect(f.notifications.remoteReferences).toHaveBeenCalledWith(f.user, expect.objectContaining({ excludeTypes: ['reaction'] }), false);
		f.stored.clear(); await expect(f.service.read(f.user, { cursor: first.cursor })).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
	});

	test('drops peer rows on grant rotation and reports partial failure without stale bodies', async () => {
		const f = fixture(); const first = await f.service.read(f.user, { limit: 4 });
		f.links.privateLink.mockResolvedValue({ id: 'new-link', generation: 2, privateTokenCipher: 'new' } as never);
		const rotated = await f.service.read(f.user, { cursor: first.cursor, mode: 'validate', count: 4 });
		expect(rotated.items.every(item => item.source === 'local')).toBe(true);
		expect(rotated.sources.find(item => item.source === 'peer')?.status).toBe('unauthorized');
		f.notifications.remoteReferences.mockRejectedValue(new GridspaceLinkError('PEER_UNAVAILABLE'));
		const failure = await f.service.read(f.user, { mode: 'refresh' });
		expect(failure.complete).toBe(false); expect(failure.items.every(item => item.source === 'local')).toBe(true);
	});

	test('removes all response bodies if a source fails after one delivery batch', async () => {
		const f = fixture();
		f.notifications.remote.mockRejectedValue(new GridspaceLinkError('PEER_UNAVAILABLE'));
		const page = await f.service.read(f.user, {});
		expect(page.items.every(item => item.source === 'local')).toBe(true);
		expect(page.sources.find(source => source.source === 'peer')?.unreadCount).toBeNull();
	});

	test('refresh retains the previously loaded boundary when new arrivals fill a page', async () => {
		const f = fixture(); const first = await f.service.read(f.user, { limit: 2 });
		f.peerRefs.unshift({ id: 'new', createdAt: at(10) });
		const refresh = await f.service.read(f.user, { cursor: first.cursor, mode: 'refresh', count: 2, limit: 2 });
		expect(refresh.items.map(item => item.id)).toEqual(['new', 'p1', 'same']);
		expect(refresh.scannedCount).toBe(3);
	});

	test('caps oversized sources and requires first-party session credentials', async () => {
		const f = fixture(); f.notifications.remoteReferences.mockResolvedValue({ origin: 'https://peer', recipientId: 'old', items: [], complete: false });
		const page = await f.service.read(f.user, {});
		expect(page.complete).toBe(false);
		expect(meta.requireCredential).toBe(true); expect(meta.secure).toBe(true);
		expect('allowGet' in meta).toBe(false); expect(paramDef.properties.count.maximum).toBe(6000);
	});

	test('bounds source wait time and never renews an expired body lease', async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			f.notifications.remote.mockImplementation(async () => new Promise(() => {}));
			const pending = f.service.read(f.user, {});
			await vi.advanceTimersByTimeAsync(8001);
			const page = await pending;
			expect(page.sources.find(source => source.source === 'peer')?.status).toBe('unavailable');
			expect(page.items.every(item => item.source === 'local')).toBe(true);
			expect(page.revalidateAfterMs).toBeLessThanOrEqual(2000);
		} finally { vi.useRealTimers(); }
	});

	test('rejects oversized response bodies without persisting or returning any of them', async () => {
		const f = fixture();
		f.notifications.remote.mockResolvedValue({ origin: 'https://peer', recipientId: 'old', unreadCount: 1, items: [{ id: 'p1', body: 'x'.repeat(650 * 1024) }] } as never);
		const page = await f.service.read(f.user, {});
		expect(page.sources.find(source => source.source === 'peer')?.status).toBe('unavailable');
		expect(page.items.every(item => item.source === 'local')).toBe(true);
		expect([...f.stored.values()].join('').length).toBeLessThan(4096);
	});

	test('projects only reference fields even if a peer adds unexpected protected fields', async () => {
		const f = fixture();
		f.notifications.remoteReferences.mockResolvedValue({ origin: 'https://peer', recipientId: 'old', complete: true, items: [{ id: 'p1', createdAt: at(5), body: 'DO NOT STORE' }] } as never);
		await f.service.read(f.user, {});
		expect([...f.stored.values()].join('')).not.toContain('DO NOT STORE');
	});
});
