/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '@/config.js';
import { saveNotificationSnapshotScript } from './GridspaceNotificationTimelineService.js';

const config = loadConfig();
const prefix = `notification-timeline-test:${randomUUID()}:`;
const redis = new Redis({ ...config.redis, keyPrefix: '' });
afterAll(async () => {
	const keys = await redis.keys(`${prefix}*`);
	if (keys.length) await redis.del(...keys);
	await redis.quit();
});

test('snapshot CAS preserves the first value and bounds concurrently created sessions', async () => {
	const key = prefix + 'stable'; const index = prefix + 'user'; const now = Date.now();
	await Promise.all(Array.from({ length: 12 }, (_, n) => redis.eval(saveNotificationSnapshotScript, 2, key, index, JSON.stringify({ refs: [n] }), 1800, now)));
	const first = await redis.get(key);
	await redis.eval(saveNotificationSnapshotScript, 2, key, index, 'replacement', 1800, now);
	await expect(redis.get(key)).resolves.toBe(first);
	await Promise.all(Array.from({ length: 20 }, (_, n) => redis.eval(saveNotificationSnapshotScript, 2, `${prefix}${n}`, index, '{}', 1800, now + n + 1)));
	expect(await redis.zcard(index)).toBe(8);
	expect((await redis.keys(`${prefix}*`)).length).toBe(9);
	expect(await redis.ttl(`${prefix}19`)).toBeGreaterThan(1700);
});

test('expired checkpoints cannot be replayed', async () => {
	const key = prefix + 'expires'; const index = prefix + 'expires-user';
	await redis.eval(saveNotificationSnapshotScript, 2, key, index, '{}', 1800, Date.now());
	await redis.pexpire(key, 1);
	await new Promise(resolve => setTimeout(resolve, 5));
	await expect(redis.get(key)).resolves.toBeNull();
});
