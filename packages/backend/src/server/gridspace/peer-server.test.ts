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

async function server(enabled = true, claim?: ClaimGridspaceNonce, action?: Parameters<typeof registerGridspacePeer>[3], notes?: Parameters<typeof registerGridspacePeer>[4], history?: Parameters<typeof registerGridspacePeer>[5], search?: Parameters<typeof registerGridspacePeer>[6], replyAction?: Parameters<typeof registerGridspacePeer>[8]) {
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
		}), action, notes, history, search, undefined, replyAction);
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

describe('GridSpace delegated reply transport', () => {
	test('requires the signed peer, bounds text and forbids caller-selected audiences or identities', async () => {
		const received: object[] = [];
		const app = await server(true, undefined, undefined, undefined, undefined, undefined, async body => { received.push(body); return { createdNoteId: 'reply' }; });
		const url = '/gridspace/v1/private/reply';
		const input = { accessToken: 'fixture', linkId: '00000000-0000-4000-8000-000000000001', generation: 1, localUserId: 'viewer', noteId: 'parent', action: 'send', requestId: '00000000-0000-4000-8000-000000000002', text: 'reply' };
		const send = (value: object, signed = true) => {
			const payload = Buffer.from(JSON.stringify(value));
			return app.inject({ method: 'POST', url, payload, headers: signed ? createGridspaceHeaders(g, 'POST', url, payload) : { 'content-type': 'application/json' } });
		};
		expect((await send(input, false)).statusCode).toBe(403);
		for (const extra of [{ text: '' }, { text: '  ' }, { text: 'a'.repeat(3001) }, { cw: 'a'.repeat(101) }, { requestId: 'not-a-uuid' }]) {
			expect((await send({ ...input, ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
		}
		// Fastify strips unknown properties; none can reach the posting service.
		for (const extra of [{ visibility: 'public' }, { visibleUserIds: ['outsider'] }, { userId: 'other' }, { localOnly: false }]) {
			expect((await send({ ...input, ...extra })).statusCode).toBe(200);
			expect(received.at(-1)).toEqual(input);
		}
		const response = await send(input);
		expect(response.statusCode).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(received).toHaveLength(5);
		expect((await (await server(false)).inject({ method: 'POST', url, payload: input })).statusCode).toBe(404);
	});
});

describe('GridSpace search transport', () => {
	test('authenticates, bounds queries, rejects delegation and advertises only implemented search', async () => {
		let calls = 0;
		const app = await server(true, undefined, undefined, undefined, undefined, async () => { calls++; return { active: true, items: [] }; });
		const url = '/gridspace/v1/search';
		const input = { kind: 'notes', query: 'past notes', limit: 20 };
		const send = (body: object, signed = true) => {
			const payload = Buffer.from(JSON.stringify(body));
			return app.inject({ method: 'POST', url, payload, headers: signed ? createGridspaceHeaders(g, 'POST', url, payload) : { 'content-type': 'application/json' } });
		};
		expect((await app.inject(request())).json().features).toEqual(['community-search']);
		expect((await send(input, false)).statusCode).toBe(403);
		expect((await send(input)).statusCode).toBe(200);
		for (const extra of [{ query: 'a'.repeat(201) }, { query: '' }, { limit: 21 }, { ids: Array.from({ length: 21 }, (_, n) => String(n)) }, { viewerId: '../secret' }, { link: { id: '87d7b3cb-7e34-427e-b1b2-af4c93b2e07a', generation: 1, counterpartId: 'me' } }]) {
			expect((await send({ ...input, ...extra })).statusCode).toBe(400);
		}
		expect(calls).toBe(1);
	});

	test('hides failures and never mounts on an ordinary instance', async () => {
		const app = await server(true, undefined, undefined, undefined, undefined, async () => { throw new Error('synthetic secret'); });
		const url = '/gridspace/v1/search';
		const payload = Buffer.from(JSON.stringify({ kind: 'users', query: 'someone', limit: 10 }));
		const response = await app.inject({ method: 'POST', url, payload, headers: createGridspaceHeaders(g, 'POST', url, payload) });
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({ error: 'PEER_SEARCH_UNAVAILABLE' });
		expect(response.headers['cache-control']).toBe('no-store');
		expect((await (await server(false)).inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404);
	});
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

describe('GridSpace note transport', () => {
	test.each(['read', 'sync'])('authenticates and replay-protects %s', async name => {
		let calls = 0;
		const app = await server(true, undefined, undefined, async () => { calls++; return { ok: true }; });
		const url = `/gridspace/v1/notes/${name}`;
		const payload = Buffer.from(JSON.stringify({ noteId: 'test' }));
		expect((await app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(403);
		const input = { method: 'POST' as const, url, payload, headers: createGridspaceHeaders(g, 'POST', url, payload) };
		expect((await app.inject(input)).statusCode).toBe(200);
		expect((await app.inject(input)).statusCode).toBe(409);
		expect(calls).toBe(1);
	});
});

describe('GridSpace history transport', () => {
	test('authenticates, limits and replay-protects history requests', async () => {
		let calls = 0;
		const app = await server(true, undefined, undefined, undefined, async () => { calls++; return { active: true, items: [] }; });
		const url = '/gridspace/v1/history';
		const body = { userId: 'a', counterpartId: 'b', linkId: '46059293-4b67-4834-9786-d86f092887e7', generation: 1, limit: 10, withReplies: true, withRenotes: true, withFiles: false };
		const payload = Buffer.from(JSON.stringify(body));
		expect((await app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(403);
		const input = { method: 'POST' as const, url, payload, headers: createGridspaceHeaders(g, 'POST', url, payload) };
		expect((await app.inject(input)).statusCode).toBe(200);
		expect((await app.inject(input)).statusCode).toBe(409);
		const oversized = Buffer.from(JSON.stringify({ ...body, limit: 21 }));
		expect((await app.inject({ method: 'POST', url, payload: oversized, headers: createGridspaceHeaders(g, 'POST', url, oversized) })).statusCode).toBe(400);
		expect(calls).toBe(1);
		expect((await app.inject(request())).json().features).toContain('member-history');
	});
});
