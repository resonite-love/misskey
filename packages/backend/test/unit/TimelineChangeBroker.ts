/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import * as Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { TimelineChangeBroker } from '@/core/gridspace/timeline/TimelineChangeBroker.js';
import { TimelineReferenceService } from '@/core/gridspace/timeline/TimelineReferenceService.js';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import type { IdService } from '@/core/IdService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { TimelineChange } from '@/core/gridspace/timeline/TimelineReferenceService.js';

describe('shared timeline change metadata broker', () => {
	const prefix = `timeline-broker-test:${randomUUID()}:`;
	let redis: Redis.Redis;
	beforeAll(() => { redis = new Redis.Redis({ ...loadConfig().redis, keyPrefix: prefix }); });
	afterAll(async () => {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length) await redis.del(...keys.map(key => key.slice(prefix.length)));
		await redis.quit();
	});
	const event = (sequence: number): TimelineChange => ({ sequence: String(sequence), canonicalUri: `https://example.test/notes/${sequence}`, noteId: String(sequence), kind: 'insert', affectedUserId: null, createdAt: new Date(0) });
	const clear = async () => {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length) await redis.del(...keys.map(key => key.slice(prefix.length)));
	};

	test('three staggered tabs and distinct server workers read one shared snapshot', async () => {
		await clear();
		const load = vi.fn(async () => ({ head: '12', trimmedThrough: '0', events: Array.from({ length: 12 }, (_, i) => event(i + 1)) }));
		const block = vi.fn(async () => [] as TimelineChange[]);
		const first = await new TimelineChangeBroker(redis).changes('0', 5, load, block);
		await new Promise(resolve => setTimeout(resolve, 1100));
		const second = await new TimelineChangeBroker(redis).changes('3', 5, load, block);
		await new Promise(resolve => setTimeout(resolve, 1100));
		const third = await new TimelineChangeBroker(redis).changes('10', 5, load, block);
		expect(load).toHaveBeenCalledTimes(1);
		expect(block).not.toHaveBeenCalled();
		expect(first.events.map(value => value.sequence)).toEqual(['1', '2', '3', '4', '5']);
		expect(second.events.map(value => value.sequence)).toEqual(['4', '5', '6', '7', '8']);
		expect(third.events.map(value => value.sequence)).toEqual(['11', '12']);
		expect(third).toMatchObject({ cursor: '12', hasMore: false });
	});

	test('aligned blocks reuse a bounded old range across different cursors', async () => {
		await clear();
		const all = Array.from({ length: 2200 }, (_, i) => event(i + 1));
		const load = vi.fn(async () => ({ head: '2200', trimmedThrough: '0', events: all.slice(-1024) }));
		const block = vi.fn(async (after: string, until: string) => all.filter(value => BigInt(value.sequence) > BigInt(after) && BigInt(value.sequence) <= BigInt(until)));
		const a = await new TimelineChangeBroker(redis).changes('0', 100, load, block);
		const b = await new TimelineChangeBroker(redis).changes('100', 100, load, block);
		expect(a).toMatchObject({ cursor: '100', hasMore: true });
		expect(b).toMatchObject({ cursor: '200', hasMore: true });
		expect(load).toHaveBeenCalledTimes(1);
		expect(block).toHaveBeenCalledTimes(1);
	});

	test('a retention race never turns a missing event into an advanced cursor', async () => {
		await clear();
		const broker = new TimelineChangeBroker(redis);
		const result = await broker.changes('0', 100, async () => ({ head: '2000', trimmedThrough: '0', events: Array.from({ length: 1024 }, (_, i) => event(977 + i)) }), async () => [event(2), event(3)]);
		expect(result).toMatchObject({ resetRequired: true, events: [], cursor: '2000' });
	});

	test('a retained cursor inside an older aligned block does not produce a false gap', async () => {
		await clear();
		const all = Array.from({ length: 3500 }, (_, i) => event(1501 + i));
		const broker = new TimelineChangeBroker(redis);
		const result = await broker.changes('1600', 100, async () => ({ head: '5000', trimmedThrough: '1500', events: all.slice(-1024) }), async (after, until) => all.filter(row => BigInt(row.sequence) > BigInt(after) && BigInt(row.sequence) <= BigInt(until)));
		expect(result).toMatchObject({ resetRequired: false, cursor: '1700', hasMore: true });
		expect(result.events[0].sequence).toBe('1601');
	});

	test('an expired producer lease cannot overwrite a newer worker snapshot', async () => {
		await clear();
		let unlock!: () => void; let reached!: () => void;
		const started = new Promise<void>(resolve => { reached = resolve; });
		const gate = new Promise<void>(resolve => { unlock = resolve; });
		const slow = new TimelineChangeBroker(redis).head(async () => { reached(); await gate; return { head: '1', trimmedThrough: '0', events: [event(1)] }; });
		await started;
		await redis.pexpire('gridspace:timeline-metadata:v1:lock:current', 1);
		await new Promise(resolve => setTimeout(resolve, 10));
		const fast = await new TimelineChangeBroker(redis).head(async () => ({ head: '2', trimmedThrough: '0', events: [event(1), event(2)] }));
		unlock();
		expect(fast).toBe('2'); expect(await slow).toBe('2');
		expect(await new TimelineChangeBroker(redis).head(async () => { throw new Error('must be cached'); })).toBe('2');
	});

	test('concurrent workers claim one producer and old blocks stay bounded', async () => {
		await clear();
		const all = Array.from({ length: 40000 }, (_, i) => event(i + 1));
		const load = vi.fn(async () => ({ head: '40000', trimmedThrough: '0', events: all.slice(-1024) }));
		const block = vi.fn(async (after: string, until: string) => all.filter(value => BigInt(value.sequence) > BigInt(after) && BigInt(value.sequence) <= BigInt(until)));
		await Promise.all(Array.from({ length: 3 }, () => new TimelineChangeBroker(redis).changes('0', 10, load, block)));
		expect(load).toHaveBeenCalledTimes(1); expect(block).toHaveBeenCalledTimes(1);
		for (let i = 1; i < 37; i++) await new TimelineChangeBroker(redis).changes(String(i * 1024), 10, load, block);
		expect((await redis.keys(`${prefix}gridspace:timeline-metadata:v1:block:*`)).length).toBeLessThanOrEqual(32);
	});

	test('the same metadata range does not retain a caller authorization decision', async () => {
		await clear();
		const load = vi.fn(async () => ({ head: '1', trimmedThrough: '0', events: [event(1)] }));
		const broker = new TimelineChangeBroker(redis);
		const first = await broker.changes('0', 10, load, async () => []);
		first.events[0].noteId = 'mutated-by-caller';
		const second = await broker.changes('0', 10, load, async () => []);
		expect(second.events[0].noteId).toBe('1');
		expect(second.events[0].createdAt).toBeInstanceOf(Date);
		expect(Object.keys(second.events[0]).sort()).toEqual(['affectedUserId', 'canonicalUri', 'createdAt', 'kind', 'noteId', 'sequence']);
		expect(broker.metrics()).toMatchObject({ producerLoads: 1, cacheHits: 1 });
	});

	test('reference-service workers avoid repeated sequencer transactions and event queries', async () => {
		await clear();
		const query = { where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), getMany: vi.fn(async () => [event(3), event(2), event(1)]) };
		const repository = { findOneByOrFail: vi.fn(async () => ({ trimmedThrough: '0' })), createQueryBuilder: vi.fn(() => query) };
		const db = { getRepository: vi.fn(() => repository) } as unknown as DataSource;
		const services = Array.from({ length: 3 }, () => new TimelineReferenceService(db, {} as Config, {} as IdService, {} as GlobalEventService, new TimelineChangeBroker(redis)));
		const sequencers = services.map(service => vi.spyOn(service, 'drainChanges').mockResolvedValue('3'));
		await services[0].changes('0'); await services[1].changes('1'); await services[2].changes('2');
		expect(sequencers.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
		expect(query.getMany).toHaveBeenCalledTimes(1);
		expect(repository.findOneByOrFail).toHaveBeenCalledTimes(1);
	});
});
