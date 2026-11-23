/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { measurePeerRequest, type SlowRequestRecord } from '@/misc/request-performance.js';
import { registerSlowRequests } from './slow-requests.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('slow request diagnostics', () => {
	test('isolates concurrent requests, includes response body time and never retains secrets', async () => {
		const app = Fastify();
		const records: SlowRequestRecord[] = [];
		registerSlowRequests(app, row => records.push(row), 0);
		app.post('/api/slow', async () => {
			await measurePeerRequest('/gridspace/v1/private/notes', () => pause(25));
			return { text: 'private response' };
		});
		app.post('/api/fast', async () => ({ ok: true }));
		const [slow, fast] = await Promise.all([
			app.inject({ method: 'POST', url: '/api/slow?i=query-secret', payload: { i: 'token-secret', text: 'private request' } }),
			app.inject({ method: 'POST', url: '/api/fast' }),
		]);
		expect(slow.statusCode).toBe(200);
		expect(fast.statusCode).toBe(200);
		const record = records.find(row => row.route === '/api/slow')!;
		expect(record.id).toBe(slow.headers['x-misskey-request-id']);
		expect(record.durationMs).toBeGreaterThanOrEqual(20);
		expect(record.peers).toEqual([{ route: '/gridspace/v1/private/notes', count: 1, failures: 0, durationMs: expect.any(Number) }]);
		expect(record.peers[0].durationMs).toBeGreaterThanOrEqual(20);
		expect(records.find(row => row.route === '/api/fast')!.peers).toEqual([]);
		expect(JSON.stringify(records)).not.toMatch(/secret|private response|private request/);
		await app.close();
	});

	test('keeps typed failure information and excludes arbitrary error text and route parameters', async () => {
		const app = Fastify();
		const records: SlowRequestRecord[] = [];
		registerSlowRequests(app, row => records.push(row), 0);
		app.post('/gridspace/v1/test/:id', async (_request, reply) => {
			await measurePeerRequest('/untrusted?token=secret', () => Promise.reject(new Error('secret'))).catch(() => {});
			return reply.code(400).send({ error: { code: 'GRIDSPACE_TIMELINE_SESSION_UNAVAILABLE', info: { reason: 'PEER_UNAVAILABLE' }, message: 'secret' } });
		});
		await app.inject({ method: 'POST', url: '/gridspace/v1/test/secret' });
		expect(records[0]).toMatchObject({ route: '/gridspace/v1/test/:id', statusCode: 400, errorCode: 'GRIDSPACE_TIMELINE_SESSION_UNAVAILABLE', errorReason: 'PEER_UNAVAILABLE', peers: [{ route: 'other', failures: 1 }] });
		expect(JSON.stringify(records)).not.toContain('secret');
		await app.close();
	});

	test('omits fast requests, unmatched paths and non-API routes', async () => {
		const app = Fastify();
		const records: SlowRequestRecord[] = [];
		registerSlowRequests(app, row => records.push(row));
		app.get('/api/ping', async () => ({}));
		app.get('/assets/:name', async () => ({}));
		await app.inject('/api/ping');
		await app.inject('/api/unknown?i=secret');
		await app.inject('/assets/private');
		expect(records).toEqual([]);
		await app.close();
	});
});
