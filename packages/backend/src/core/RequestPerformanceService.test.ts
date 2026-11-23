/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import * as Redis from 'ioredis';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig } from '@/config.js';
import type { SlowRequestRecord } from '@/misc/request-performance.js';
import type { LoggerService } from './LoggerService.js';
import type Logger from '@/logger.js';
import { RequestPerformanceService, SLOW_REQUEST_LIMIT, SLOW_REQUEST_RETENTION_MS } from './RequestPerformanceService.js';

const config = loadConfig();
const redis = new Redis.Redis({ host: config.redis.host, port: config.redis.port, keyPrefix: `test:slow-requests:${randomUUID()}:` });
const key = 'slow-api-requests:v1';
afterAll(async () => { await redis.del(key); await redis.quit(); });

function entry(time = Date.now()): SlowRequestRecord {
	return { id: randomUUID(), createdAt: new Date(time).toISOString(), route: '/api/example', method: 'POST', statusCode: 200, durationMs: 1200, errorCode: null, errorReason: null, peers: [] };
}

describe('slow request storage', () => {
	test('physically removes old records, keeps only the newest 500 and reads across worker instances', async () => {
		const logger = mockDeep<LoggerService>();
		logger.getLogger.mockReturnValue(mockDeep<Logger>());
		const writer = new RequestPerformanceService(redis, logger);
		const reader = new RequestPerformanceService(redis, logger);
		const now = Date.now();
		const old = entry(now - SLOW_REQUEST_RETENTION_MS - 1000);
		await redis.zadd(key, Date.parse(old.createdAt), JSON.stringify(old));
		expect(await reader.recent()).toEqual([]);
		expect(await redis.zcard(key)).toBe(0);
		const values = Array.from({ length: SLOW_REQUEST_LIMIT + 2 }, (_, index) => entry(now - index));
		await redis.zadd(key, ...values.flatMap(value => [Date.parse(value.createdAt), JSON.stringify(value)]));
		await redis.zadd(key, Date.parse(old.createdAt), JSON.stringify(old));
		const newest = entry(now + 1);
		writer.record(newest);
		await vi.waitFor(async () => expect(await redis.zcard(key)).toBe(SLOW_REQUEST_LIMIT));
		const rows = await reader.recent();
		expect(rows[0].id).toBe(newest.id);
		expect(rows.some(row => row.id === old.id)).toBe(false);
		expect(await redis.zscore(key, JSON.stringify(old))).toBeNull();
		expect(await redis.ttl(key)).toBeGreaterThan(0);
	});

	test('bounds outstanding writes and recovers after a storage failure without rejecting a request', async () => {
		const unavailable = mockDeep<Redis.Redis>();
		let reject!: (reason: Error) => void;
		const pipeline = { zadd: vi.fn().mockReturnThis(), zremrangebyscore: vi.fn().mockReturnThis(), zremrangebyrank: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(), exec: vi.fn(() => new Promise<null>((_resolve, fail) => { reject = fail; })) };
		unavailable.multi.mockReturnValue(pipeline as never);
		const logger = mockDeep<LoggerService>();
		logger.getLogger.mockReturnValue(mockDeep<Logger>());
		const service = new RequestPerformanceService(unavailable, logger);
		for (let index = 0; index < 20; index++) service.record(entry());
		expect(unavailable.multi).toHaveBeenCalledTimes(8);
		reject(new Error('Redis unavailable'));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(() => service.record(entry())).not.toThrow();
		expect(unavailable.multi).toHaveBeenCalledTimes(9);
	});
});
