/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { expect, test, vi } from 'vitest';
import { createGridspaceHeaders, resolveGridspaceConfig } from '@/core/gridspace/peer-protocol.js';
import { registerGridspacePeer } from './peer-server.js';

test('emoji synchronization is pair-authenticated, replay-protected and validates writes', async () => {
	const settings = { enabled: true, communityId: 'emojis', keyId: 'v1', secretEnv: 'KEY', peerUrl: 'https://r.test' };
	const env = { KEY: randomBytes(32).toString('base64') };
	const g = resolveGridspaceConfig(settings, 'https://g.test', env)!;
	const r = resolveGridspaceConfig({ ...settings, peerUrl: g.origin }, 'https://r.test', env)!;
	const handler = vi.fn(async () => ({ ok: true }));
	const nonces = new Set<string>();
	const app = Fastify();
	await app.register(rawBody, { global: false, encoding: null, runFirst: true });
	await app.register(async child => {
		const args: Parameters<typeof registerGridspacePeer> = [child, r, async key => { if (nonces.has(key)) return false; nonces.add(key); return true; }];
		args[28] = handler;
		registerGridspacePeer(...args);
	}, { prefix: '/gridspace/v1' });
	const url = '/gridspace/v1/emojis';
	try {
		const payload = JSON.stringify({ action: 'manifest' });
		expect((await app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(403);
		const headers = createGridspaceHeaders(g, 'POST', url, payload);
		expect((await app.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(200);
		expect((await app.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(409);
		const invalid = JSON.stringify({ action: 'apply', operationId: 'bad' });
		expect((await app.inject({ method: 'POST', url, payload: invalid, headers: createGridspaceHeaders(g, 'POST', url, invalid) })).statusCode).toBe(400);
		expect(handler).toHaveBeenCalledTimes(1);
	} finally { await app.close(); }
});
