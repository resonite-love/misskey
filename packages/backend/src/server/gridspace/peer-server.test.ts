/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { afterEach, describe, expect, test } from 'vitest';
import { createGridspaceHeaders, GRIDSPACE_HANDSHAKE_PATH, GRIDSPACE_NONCE_TTL_MS, resolveGridspaceConfig } from '@/core/gridspace/peer-protocol.js';
import { registerGridspacePeer } from './peer-server.js';
import type { FastifyInstance } from 'fastify';
import type { ClaimGridspaceNonce } from './peer-server.js';

const source = { enabled: true, communityId: 'lab', keyId: 'v1', secretEnv: 'GRIDSPACE_TEST_KEY', peerUrl: 'https://r.example' };
const env = { GRIDSPACE_TEST_KEY: randomBytes(32).toString('base64') };
const g = resolveGridspaceConfig(source, 'https://g.example', env)!;
const r = resolveGridspaceConfig({ ...source, peerUrl: g.origin }, source.peerUrl, env)!;
const servers: FastifyInstance[] = [];

async function server(enabled = true, claim?: ClaimGridspaceNonce, action?: Parameters<typeof registerGridspacePeer>[3]) {
	const app = Fastify();
	servers.push(app);
	const used = new Set<string>();
	await app.register(fastifyRawBody, { global: false, encoding: null, runFirst: true });
	await app.register(async child => {
		registerGridspacePeer(child, enabled ? r : null, claim ?? (async (key, ttl) => {
			expect(ttl).toBe(GRIDSPACE_NONCE_TTL_MS);
			if (used.has(key)) return false;
			used.add(key);
			return true;
		}), action);
	}, { prefix: '/gridspace/v1' });
	return app;
}

function request(protocolVersion = 1) {
	const body = Buffer.from(JSON.stringify({ protocolVersion }));
	return { method: 'POST' as const, url: GRIDSPACE_HANDSHAKE_PATH, payload: body, headers: createGridspaceHeaders(g, 'POST', GRIDSPACE_HANDSHAKE_PATH, body) };
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(app => app.close()));
});

describe('GridSpace account link transport', () => {
	test('publishes only the exact client and redirect origins', async () => {
		const app = await server(true, undefined, async () => ({}));
		const metadata = await app.inject({ method: 'GET', url: '/gridspace/v1/oauth-client' });
		expect(metadata.json()).toMatchObject({ client_id: r.origin + '/gridspace/v1/oauth-client', redirect_uris: [r.origin + '/settings/gridspace'] });
		expect((await app.inject(request())).json().features).toEqual(['account-link-follow-copy']);
	});

	test('requires a signature and rejects replay before processing a token', async () => {
		let calls = 0;
		const app = await server(true, undefined, async () => { calls++; return { id: 'person' }; });
		const url = '/gridspace/v1/link/identity';
		const payload = Buffer.from(JSON.stringify({ accessToken: 'synthetic-token' }));
		const unsigned = { method: 'POST' as const, url, payload, headers: { 'content-type': 'application/json' } };
		expect((await app.inject(unsigned)).statusCode).toBe(403);
		expect(calls).toBe(0);
		const signed = { ...unsigned, headers: createGridspaceHeaders(g, 'POST', url, payload) };
		expect((await app.inject(signed)).statusCode).toBe(200);
		expect((await app.inject(signed)).statusCode).toBe(409);
		expect(calls).toBe(1);
	});

	test('does not expose unexpected exception details', async () => {
		const app = await server(true, undefined, async () => { throw new Error('synthetic-secret'); });
		const url = '/gridspace/v1/link/identity';
		const payload = Buffer.from(JSON.stringify({ accessToken: 'synthetic-token' }));
		const response = await app.inject({ method: 'POST', url, payload, headers: createGridspaceHeaders(g, 'POST', url, payload) });
		expect(response.json()).toEqual({ error: 'PEER_UNAVAILABLE' });
		expect(response.headers['cache-control']).toBe('no-store');
	});

	test('does not register link or client routes when disabled', async () => {
		const app = await server(false, undefined, async () => ({}));
		expect((await app.inject({ method: 'GET', url: '/gridspace/v1/oauth-client' })).statusCode).toBe(404);
		expect((await app.inject({ method: 'POST', url: '/gridspace/v1/link/identity', payload: {} })).statusCode).toBe(404);
	});
});

describe('GridSpace peer handshake', () => {
	test('is absent by default', async () => {
		const response = await (await server(false)).inject(request());
		expect(response.statusCode).toBe(404);
	});

	test('authenticates a peer without advertising unfinished user features', async () => {
		const response = await (await server()).inject(request());
		expect(response.statusCode).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.json()).toEqual({ protocolVersion: 1, communityId: 'lab', origin: r.origin, peerOrigin: g.origin, features: [] });
	});

	test('refuses unsigned requests', async () => {
		const req = request();
		const response = await (await server()).inject({ ...req, headers: { 'content-type': 'application/json' } });
		expect(response.statusCode).toBe(403);
	});

	test('accepts a nonce only once across concurrent requests', async () => {
		const app = await server();
		const req = request();
		const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject(req)));
		expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1);
		expect(responses.filter(response => response.statusCode === 409)).toHaveLength(7);
	});

	test('fails closed when the shared replay store is unavailable', async () => {
		const app = await server(true, async () => { throw new Error('unavailable'); });
		expect((await app.inject(request())).statusCode).toBe(503);
	});

	test('rejects incompatible protocol versions', async () => {
		const response = await (await server()).inject(request(2));
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toBe('PEER_PROTOCOL_INCOMPATIBLE');
	});

	test('rejects changed wire bytes', async () => {
		const req = request();
		const response = await (await server()).inject({ ...req, payload: '{ "protocolVersion":1}' });
		expect(response.statusCode).toBe(403);
	});

	test('rejects malformed, oversized and unsupported bodies', async () => {
		const app = await server();
		const req = request();
		expect((await app.inject({ ...req, payload: '{' })).statusCode).toBe(400);
		expect((await app.inject({ ...req, payload: 'x'.repeat(4097) })).statusCode).toBe(413);
		expect((await app.inject({ ...req, headers: { ...req.headers, 'content-type': 'text/plain' } })).statusCode).toBe(415);
	});
});
