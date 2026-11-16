/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import Redis, { ReplyError } from 'ioredis';
import { afterAll, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig } from '@/config.js';
import type { MiNote } from '@/models/Note.js';
import { NotificationService, reactionNotificationOnceScript } from '@/core/NotificationService.js';
import type { CacheService } from '@/core/CacheService.js';
import type { IdService } from '@/core/IdService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';

const config = loadConfig();
const prefix = `reaction-test:${randomUUID()}:`;
const redis = new Redis({ ...config.redis, keyPrefix: prefix });
afterAll(async () => {
	const keys = await redis.keys(`${prefix}*`);
	// DEL through this client prefixes keys; strip only our test's exact prefix.
	if (keys.length) await redis.del(...keys.map(key => key.slice(prefix.length)));
	await redis.quit();
});

test('concurrent retries insert exactly one timeline entry and retain the receipt', async () => {
	const results = await Promise.all(Array.from({ length: 12 }, (_, i) => redis.eval(reactionNotificationOnceScript, 2, 'timeline', 'receipt', '500', `${100 + i}-1`, JSON.stringify({ id: i }))));
	expect(results.filter(value => value === 1)).toHaveLength(1);
	expect(await redis.xlen('timeline')).toBe(1);
	expect(await redis.ttl('receipt')).toBeGreaterThan(86400);
	await redis.del('timeline');
	expect(await redis.eval(reactionNotificationOnceScript, 2, 'timeline', 'receipt', '500', '999-1', '{}')).toBe(0);
	expect(await redis.exists('timeline')).toBe(0);
});

test('failed XADD never commits a receipt and a retry can succeed', async () => {
	await redis.set('broken-timeline', 'wrong type');
	await expect(redis.eval(reactionNotificationOnceScript, 2, 'broken-timeline', 'retry-receipt', '500', '1-1', '{}')).rejects.toThrow();
	expect(await redis.exists('retry-receipt')).toBe(0);
	await redis.del('broken-timeline');
	expect(await redis.eval(reactionNotificationOnceScript, 2, 'broken-timeline', 'retry-receipt', '500', '1-1', '{}')).toBe(1);
});

function fixture() {
	const cache = mockDeep<CacheService>(); const ids = mockDeep<IdService>();
	const events = mockDeep<GlobalEventService>(); const packer = mockDeep<NotificationEntityService>();
	cache.userProfileCache.fetch.mockResolvedValue({ notificationRecieveConfig: {} } as never);
	cache.userMutingsCache.fetch.mockResolvedValue(new Set());
	ids.gen.mockReturnValue('notice'); ids.parseFull.mockReturnValue({ date: 200, additional: 1n } as never);
	packer.pack.mockResolvedValue({ id: 'notice', type: 'reaction' } as never);
	const client = mockDeep<Redis>(); client.eval.mockResolvedValue(1);
	const service = new NotificationService(config, client, mockDeep(), mockDeep(), packer, ids, events, mockDeep(), cache, mockDeep());
	return { service, cache, client, events };
}

test.each(['self', 'muted', 'disabled'])('preserves %s notification suppression', async reason => {
	const f = fixture();
	if (reason === 'muted') f.cache.userMutingsCache.fetch.mockResolvedValue(new Set(['actor']));
	if (reason === 'disabled') f.cache.userProfileCache.fetch.mockResolvedValue({ notificationRecieveConfig: { reaction: { type: 'never' } } } as never);
	try {
		await f.service.createReactionNotificationOnce({ userHost: null, userId: reason === 'self' ? 'actor' : 'author', id: 'note' } as MiNote, '👍', 'actor', 'receipt');
		expect(f.client.eval).not.toHaveBeenCalled();
	} finally { f.service.onApplicationShutdown(); }
});

test('duplicate receipts emit no new stream event; permanent Redis errors reject instead of looping', async () => {
	const f = fixture(); const note = { userHost: null, userId: 'author', id: 'note' } as MiNote;
	try {
		f.client.eval.mockResolvedValue(0);
		await f.service.createReactionNotificationOnce(note, '👍', 'actor', 'receipt');
		expect(f.events.publishMainStream).not.toHaveBeenCalled();
		f.client.eval.mockRejectedValue(new ReplyError('NOPERM this user has no permissions'));
		await expect(f.service.createReactionNotificationOnce(note, '👍', 'actor', 'receipt')).rejects.toThrow('NOPERM');
		expect(f.client.eval).toHaveBeenCalledTimes(2);
	} finally { f.service.onApplicationShutdown(); }
});
