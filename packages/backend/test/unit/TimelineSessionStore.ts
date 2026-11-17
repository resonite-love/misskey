/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes, randomUUID } from 'node:crypto';
import * as Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '@/config.js';
import { TimelineSessionStore } from '@/core/gridspace/timeline/TimelineSessionStore.js';

describe('TimelineSessionStore', () => {
	let redis: Redis.Redis;
	let store: TimelineSessionStore;
	const owners: string[] = [];
	const owner = () => { const value = randomUUID(); owners.push(value); return value; };
	const expires = () => Date.now() + 60_000;

	beforeAll(() => {
		redis = new Redis.Redis(loadConfig().redis);
		store = new TimelineSessionStore(redis);
	});

	afterAll(async () => {
		for (const user of owners) {
			const sessions = await redis.zrange(`gridspace:timeline-store:viewer:${user}`, 0, -1);
			for (const session of sessions) await redis.del(`gridspace:timeline-store:owner:${session}`, `gridspace:timeline-store:session:${session}`);
			await redis.del(`gridspace:timeline-store:viewer:${user}`);
		}
		await redis.quit();
	});

	test('parallel claims select one immutable result', async () => {
		const session = randomUUID(); const page = randomUUID();
		await store.start(owner(), session, '{}', expires());
		await store.putCheckpoint(session, page, '{}', expires());
		const results = await Promise.all([store.claimResult(session, page, '{"winner":1}', expires()), store.claimResult(session, page, '{"winner":2}', expires())]);
		expect(results[0]).toBe(results[1]);
		expect(await store.claimResult(session, page, '{"winner":3}', expires())).toBe(results[0]);
	});

	test('ninth session evicts one complete session including its pages', async () => {
		const user = owner(); const sessions: string[] = [];
		for (let index = 0; index < 9; index++) {
			const session = randomUUID(); sessions.push(session);
			await store.start(user, session, '{}', expires());
			await store.putCheckpoint(session, 'page', '{}', expires());
		}
		const retained = await Promise.all(sessions.map(session => store.getSession(session)));
		expect(retained.filter(Boolean)).toHaveLength(8);
		for (const [index, value] of retained.entries()) if (!value) expect(await store.getCheckpoint(sessions[index], 'page')).toBeNull();
	});

	test('65th distinct page evicts the complete session', async () => {
		const session = randomUUID(); await store.start(owner(), session, '{}', expires());
		for (let index = 0; index < 64; index++) await store.putCheckpoint(session, String(index), '{}', expires());
		await expect(store.putCheckpoint(session, '64', '{}', expires())).rejects.toThrow();
		expect(await store.getSession(session)).toBeNull();
		expect(await store.getCheckpoint(session, '0')).toBeNull();
	});

	test('the byte limit counts all retained checkpoints and results together', async () => {
		const session = randomUUID(); await store.start(owner(), session, '{}', expires());
		await store.putCheckpoint(session, 'first', randomBytes(96000).toString('base64'), expires());
		await store.claimResult(session, 'first', randomBytes(96000).toString('base64'), expires());
		await expect(store.putCheckpoint(session, 'second', randomBytes(12000).toString('base64'), expires())).rejects.toThrow();
		expect(await store.getSession(session)).toBeNull();
	});

	test('compresses repeated references while preserving immutable page results', async () => {
		const session = randomUUID(); await store.start(owner(), session, '{}', expires());
		const json = JSON.stringify({ references: Array.from({ length: 100 }, (_, index) => ({ uri: `https://example.com/notes/${index}`, sortAt: '123456789000000', source: 'local' })) });
		for (let index = 0; index < 50; index++) {
			await store.putCheckpoint(session, String(index), json, expires());
			expect(await store.claimResult(session, String(index), json, expires())).toBe(json);
		}
		expect(await store.getCheckpoint(session, '49')).toBe(json);
	});

	test('an expired or nonexistent session cannot be resurrected by a late result', async () => {
		await expect(store.claimResult(randomUUID(), 'page', '{}', expires())).rejects.toThrow();
	});

	test('enforces idle and absolute expiry without resurrecting expired metadata', async () => {
		const session = randomUUID(); const until = Date.now() + 7200_000;
		await store.start(owner(), session, '{}', until);
		expect(await redis.pttl(`gridspace:timeline-store:owner:${session}`)).toBeLessThanOrEqual(1800_000);
		await store.putCheckpoint(session, 'page', '{}', until);
		await redis.del(`gridspace:timeline-store:owner:${session}`);
		expect(await store.getCheckpoint(session, 'page')).toBeNull();
		await expect(store.putCheckpoint(session, 'later', '{}', until)).rejects.toThrow();
	});

	test('late page writes preserve newer sequence, window head and accumulated ownership', async () => {
		const session = randomUUID(); const until = expires();
		const state = { session, expires: until, mode: 'unified', revision: '1', options: { kind: 'home' }, sequence: '1', peerSequence: '9',
			merge: { owners: { a: 'local' }, seen: ['a'], local: { upper: null }, peer: { upper: null } },
			windowHead: { sortAt: '100', source: 'local', noteId: 'a' } };
		await store.start(owner(), session, JSON.stringify(state), until);
		await store.putSession(session, JSON.stringify({ ...state, sequence: '10000000000000000', peerSequence: '10', windowHead: { sortAt: '200', source: 'local', noteId: 'b' }, merge: { ...state.merge, owners: { b: 'peer' }, seen: ['b'] } }), until);
		const merged = JSON.parse(await store.putSession(session, JSON.stringify({ ...state, sequence: '2', peerSequence: '1' }), until));
		expect(merged.sequence).toBe('10000000000000000');
		expect(merged.peerSequence).toBe('10');
		expect(merged.windowHead.noteId).toBe('b');
		expect(merged.merge.owners).toEqual({ a: 'local', b: 'peer' });
		expect(merged.merge.seen).toEqual(['a', 'b']);
	});

	test('conflicting ownership expires the session instead of replacing the choice', async () => {
		const session = randomUUID(); const until = expires();
		const state = { session, expires: until, mode: 'unified', revision: '1', merge: { owners: { a: 'local' }, seen: ['a'] } };
		await store.start(owner(), session, JSON.stringify(state), until);
		await expect(store.putSession(session, JSON.stringify({ ...state, merge: { owners: { a: 'peer' }, seen: ['a'] } }), until)).rejects.toThrow();
		expect(await store.getSession(session)).toBeNull();
	});
});
