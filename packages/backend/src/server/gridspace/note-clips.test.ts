/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { expect, test, vi } from 'vitest';
import { registerGridspacePeer } from './peer-server.js';
import { createGridspaceHeaders, resolveGridspaceConfig } from '@/core/gridspace/peer-protocol.js';

test('clip membership reads require a paired signature and a single bounded target', async () => {
	const source = { enabled: true, communityId: 'clips', keyId: 'v1', secretEnv: 'KEY', peerUrl: 'https://r.example' };
	const env = { KEY: randomBytes(32).toString('base64') };
	const g = resolveGridspaceConfig(source, 'https://g.example', env)!;
	const r = resolveGridspaceConfig({ ...source, peerUrl: g.origin }, 'https://r.example', env)!;
	const handler = vi.fn(async () => ({ clips: [] }));
	const app = Fastify();
	await app.register(fastifyRawBody, { global: false, encoding: null, runFirst: true });
	await app.register(async child => {
		const args: Parameters<typeof registerGridspacePeer> = [child, r, async () => true];
		args[27] = handler;
		registerGridspacePeer(...args);
	}, { prefix: '/gridspace/v1' });
	const url = '/gridspace/v1/notes/clips';
	try {
		const payload = JSON.stringify({ noteId: 'note' });
		expect((await app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(403);
		expect(handler).not.toHaveBeenCalled();
		expect((await app.inject({ method: 'POST', url, payload, headers: createGridspaceHeaders(g, 'POST', url, payload) })).statusCode).toBe(200);
		const invalid = JSON.stringify({ noteId: 'note', noteUri: 'https://r.example/notes/note' });
		expect((await app.inject({ method: 'POST', url, payload: invalid, headers: createGridspaceHeaders(g, 'POST', url, invalid) })).statusCode).toBe(400);
		expect(handler).toHaveBeenCalledTimes(1);
	} finally { await app.close(); }
});
