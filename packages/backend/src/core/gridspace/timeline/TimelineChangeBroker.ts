/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { TimelineChange } from './TimelineReferenceService.js';

export type TimelineChangeSnapshot = { head: string; trimmedThrough: string; events: TimelineChange[] };
export type TimelineChangePage = { events: TimelineChange[]; cursor: string; resetRequired: boolean; hasMore: boolean };
type SnapshotLoader = () => Promise<TimelineChangeSnapshot>;
type BlockLoader = (after: string, until: string) => Promise<TimelineChange[]>;

const PREFIX = 'gridspace:timeline-metadata:v1:';
const TTL = 8000;
const CAPACITY = 1024;

/** Shared commit metadata only. No viewer, filters, authorization result or body is cached. */
@Injectable()
export class TimelineChangeBroker {
	private inFlight = new Map<string, Promise<string>>();
	private statistics = { producerLoads: 0, cacheHits: 0, sharedWaits: 0 };
	constructor(@Inject(DI.redis) private readonly redis: Redis.Redis) {}
	public metrics() { return { ...this.statistics }; }
	public async invalidate(): Promise<void> { await this.redis.del(PREFIX + 'current'); }

	private async cached(key: string, load: () => Promise<unknown>): Promise<string> {
		const existing = await this.redis.get(PREFIX + key);
		if (existing != null) { this.statistics.cacheHits++; return existing; }
		const running = this.inFlight.get(key);
		if (running) { this.statistics.sharedWaits++; return running; }
		const request = this.fill(key, load);
		this.inFlight.set(key, request);
		try { return await request; } finally { this.inFlight.delete(key); }
	}

	private async fill(key: string, load: () => Promise<unknown>): Promise<string> {
		const owner = randomUUID();
		const lock = PREFIX + 'lock:' + key;
		const claimed = await this.redis.set(lock, owner, 'PX', 4000, 'NX') === 'OK';
		if (!claimed) {
			this.statistics.sharedWaits++;
			// The producer publishes its snapshot before unlocking. A waiter never
			// returns an incomplete range or invents a cursor while it is pending.
			for (let attempt = 0; attempt < 100; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 20));
				const value = await this.redis.get(PREFIX + key);
				if (value != null) return value;
			}
			throw new Error('Timeline metadata producer unavailable');
		}
		try {
			const completed = await this.redis.get(PREFIX + key);
			if (completed != null) { this.statistics.cacheHits++; return completed; }
			this.statistics.producerLoads++;
			const value = JSON.stringify(await load());
			const published = await this.redis.eval(`if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]); return ARGV[2]`, 2, lock, PREFIX + key, owner, value, TTL) as string | null;
			if (published == null) {
				// A timed-out producer cannot overwrite its successor or return an
				// obsolete head while that successor is still being published.
				for (let attempt = 0; attempt < 100; attempt++) {
					const replacement = await this.redis.get(PREFIX + key);
					if (replacement != null) return replacement;
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				throw new Error('Timeline metadata lease expired');
			}
			if (key.startsWith('block:')) {
				await this.redis.eval(`redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
local excess = redis.call('ZCARD', KEYS[1]) - 32
if excess > 0 then
 for _, key in ipairs(redis.call('ZRANGE', KEYS[1], 0, excess - 1)) do redis.call('DEL', key); redis.call('ZREM', KEYS[1], key) end
end
redis.call('PEXPIRE', KEYS[1], 8000)`, 1, PREFIX + 'blocks', Date.now(), `${this.redis.options.keyPrefix ?? ''}${PREFIX}${key}`);
			}
			return value;
		} finally {
			await this.redis.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, lock, owner);
		}
	}

	private async snapshot(load: SnapshotLoader): Promise<TimelineChangeSnapshot> {
		const snapshot = JSON.parse(await this.cached('current', load)) as TimelineChangeSnapshot;
		snapshot.events = snapshot.events.map(event => ({ ...event, createdAt: new Date(event.createdAt) }));
		return snapshot;
	}

	public async head(load: SnapshotLoader): Promise<string> { return (await this.snapshot(load)).head; }

	public async changes(after: string, limit: number, load: SnapshotLoader, loadBlock: BlockLoader): Promise<TimelineChangePage> {
		const snapshot = await this.snapshot(load);
		const position = BigInt(after);
		const head = BigInt(snapshot.head);
		if (position > head || position < BigInt(snapshot.trimmedThrough)) return { events: [], cursor: snapshot.head, resetRequired: true, hasMore: false };
		if (position === head) return { events: [], cursor: after, resetRequired: false, hasMore: false };
		let rows = snapshot.events;
		const first = rows[0]?.sequence;
		let until = head;
		let expectedStart = first == null ? head + 1n : BigInt(first);
		if (first == null || position < BigInt(first) - 1n) {
			const start = (position / BigInt(CAPACITY)) * BigInt(CAPACITY);
			until = start + BigInt(CAPACITY) < head ? start + BigInt(CAPACITY) : head;
			const key = `block:${start}:${until}`;
			rows = (JSON.parse(await this.cached(key, () => loadBlock(String(start), String(until)))) as TimelineChange[]).map(event => ({ ...event, createdAt: new Date(event.createdAt) }));
			expectedStart = start + 1n;
		}
		// Retention can advance while a reader is loading an old cached-head block.
		// A missing committed sequence is a gap, never permission to skip it.
		expectedStart = position + 1n > expectedStart ? position + 1n : expectedStart;
		for (const row of rows) {
			if (BigInt(row.sequence) <= position) continue;
			if (BigInt(row.sequence) !== expectedStart++) return { events: [], cursor: snapshot.head, resetRequired: true, hasMore: false };
		}
		if (rows.length && expectedStart - 1n !== until) return { events: [], cursor: snapshot.head, resetRequired: true, hasMore: false };
		if (!rows.length && position < until) return { events: [], cursor: snapshot.head, resetRequired: true, hasMore: false };
		const eligible = rows.filter(row => BigInt(row.sequence) > position && BigInt(row.sequence) <= until);
		const events = eligible.slice(0, limit);
		const cursor = events.length ? events.at(-1)!.sequence : String(until);
		const hasMore = BigInt(cursor) < head;
		return { events, cursor, resetRequired: false, hasMore };
	}
}
