/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import { NotificationService } from '@/core/NotificationService.js';
import type { MiNote } from '@/models/Note.js';

const base = { id: 'note', userId: 'author', userHost: 'g.example', channelId: 'channel', localOnly: true, uri: null };

function fixture(role = 'source', enabled = true) {
	const service = Object.assign(Object.create(NotificationService.prototype), { config: { gridspace: { enabled, channelRole: role, peerUrl: 'https://g.example' } } as Config }) as NotificationService;
	const create = vi.spyOn(service, 'createNotification').mockImplementation(() => {});
	return { service, create };
}

test.each(['👍', '🎉'])('creates a channel-author notification for primary and additional reactions: %s', reaction => {
	const f = fixture();
	f.service.createReactionNotification(base, reaction, 'reactor');
	expect(f.create).toHaveBeenCalledWith('author', 'reaction', { noteId: 'note', reaction }, 'reactor');
});
test.each([{ userHost: 'other.example' }, { channelId: null }, { localOnly: false }, { uri: 'https://g.example/notes/remote' }])('does not extend notification delivery to unrelated remote posts: %j', change => {
	const f = fixture(); f.service.createReactionNotification({ ...base, ...change }, '👍', 'reactor'); expect(f.create).not.toHaveBeenCalled();
});
test.each([['client', true], ['source', false]])('requires enabled source role: %s %s', (role, enabled) => {
	const f = fixture(role as string, enabled as boolean); f.service.createReactionNotification(base, '👍', 'reactor'); expect(f.create).not.toHaveBeenCalled();
});
test('preserves ordinary local-user notifications with the feature disabled', () => {
	const f = fixture('source', false); f.service.createReactionNotification({ ...base, userHost: null } as MiNote, '👍', 'reactor'); expect(f.create).toHaveBeenCalledOnce();
});

test('persists a remote channel-author notification through the real creation path', async () => {
	const redis = mockDeep<import('ioredis').Redis>();
	const reads = mockDeep<import('@/core/NotificationReadService.js').NotificationReadService>();
	const packer = mockDeep<import('@/core/entities/NotificationEntityService.js').NotificationEntityService>();
	const ids = mockDeep<import('@/core/IdService.js').IdService>();
	const events = mockDeep<import('@/core/GlobalEventService.js').GlobalEventService>();
	const cache = mockDeep<import('@/core/CacheService.js').CacheService>();
	cache.userProfileCache.fetch.mockResolvedValue({ notificationRecieveConfig: {} } as never);
	cache.userMutingsCache.fetch.mockResolvedValue(new Set());
	ids.gen.mockReturnValue('notice'); ids.parseFull.mockReturnValue({ date: 1, additional: 1n } as never);
	redis.xadd.mockResolvedValue('1-1'); packer.pack.mockResolvedValue({ id: 'notice', type: 'reaction' } as never);
	const service = new NotificationService({ gridspace: { enabled: true, channelRole: 'source', peerUrl: 'https://g.example' }, perUserNotificationsMaxCount: 500 } as Config,
		redis, mockDeep(), reads, packer, ids, events, mockDeep(), cache, mockDeep());
	try {
		service.createReactionNotification(base, '👍', 'reactor');
		await vi.waitFor(() => expect(events.publishMainStream).toHaveBeenCalled());
		expect(redis.xadd.mock.calls[0][0]).toBe('notificationTimeline:author');
		expect(JSON.parse(redis.xadd.mock.calls[0].at(-1) as string)).toMatchObject({ type: 'reaction', noteId: 'note', notifierId: 'reactor', reaction: '👍' });
	} finally { service.onApplicationShutdown(); }
});
