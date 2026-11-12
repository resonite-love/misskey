/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { gridspacePeerTransport, GridspaceProtocolMismatch, requestGridspacePeer } from './peer-client.js';
import { verifyGridspaceRequest, type GridspacePeerConfig } from './peer-protocol.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => {
		server.closeAllConnections();
		return new Promise<void>(resolve => server.close(() => resolve()));
	}));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
	const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); }); });
	servers.push(server);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing test address');
	return `http://127.0.0.1:${address.port}`;
}

function peer(origin: string, peerOrigin: string): GridspacePeerConfig {
	// Loopback HTTP is confined to this transport fixture; production config requires HTTPS.
	return { origin, peerOrigin, communityId: 'test', keyId: 'test', secret: Buffer.alloc(32, 9) };
}

function link(config: GridspacePeerConfig) {
	// Exercise the same transport used by OAuth, authorization checks, private reads and replies.
	return { json: GridspaceLinkService.prototype.json, enabled: () => config } as unknown as GridspaceLinkService;
}

describe('GridSpace peer transport', () => {
	test('classifies only the fixed handshake protocol error without returning peer details', async () => {
		const origin = await listen((_req, res) => { res.statusCode = 409; res.end('{"error":"PEER_PROTOCOL_INCOMPATIBLE","token":"not-for-output"}'); });
		const config = peer('https://g.example', origin);
		await expect(requestGridspacePeer(config, '/gridspace/v1/handshake', {})).rejects.toBeInstanceOf(GridspaceProtocolMismatch);
		await expect(requestGridspacePeer(config, '/other', {})).rejects.not.toBeInstanceOf(GridspaceProtocolMismatch);
	});
	test('reciprocal syncs can make callbacks while independent authorization proceeds', async () => {
		let release!: () => void; let entered = 0;
		const bothEntered = new Promise<void>(resolve => { release = resolve; });
		const versions: string[] = [];
		const handler = (remote: () => GridspacePeerConfig) => async (req: IncomingMessage, res: ServerResponse) => {
			versions.push(req.httpVersion);
			if (req.url === '/sync') {
				if (++entered === 2) release();
				await bothEntered;
				await link(remote()).json('/read', {});
			}
			res.end('{"ok":true}');
		};
		const gOrigin = await listen(handler(() => g));
		const rOrigin = await listen(handler(() => r));
		const g = peer(gOrigin, rOrigin); const r = peer(rOrigin, gOrigin);
		const deadline = Date.now() + 2000;
		await expect(Promise.all([
			requestGridspacePeer(g, '/sync', {}, 1024, deadline), requestGridspacePeer(r, '/sync', {}, 1024, deadline),
			link(g).json('/check', {}), link(r).json('/check', {}),
		])).resolves.toEqual(Array.from({ length: 4 }, () => ({ ok: true })));
		expect(versions).toHaveLength(6);
		expect(versions.every(version => version === '1.1')).toBe(true);
	});

	test('signs exact UTF-8 bodies with fresh nonces in both clients', async () => {
		const nonces: (string | null)[] = [];
		const origin = await listen(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			expect(JSON.parse(body.toString())).toEqual({ text: '日本語の投稿', count: 1 });
			nonces.push(verifyGridspaceRequest(peer(config.peerOrigin, config.origin), req.method!, req.url!, body, req.headers));
			res.end('{"ok":true}');
		});
		const config = peer('https://g.example', origin);
		await requestGridspacePeer(config, '/read', { text: '日本語の投稿', count: 1 });
		await link(config).json('/check', { text: '日本語の投稿', count: 1 });
		expect(nonces.every(Boolean)).toBe(true); expect(new Set(nonces).size).toBe(2);
	});

	test('bounds chunked response bodies in both clients', async () => {
		const origin = await listen((_req, res) => { res.write('{"text":"'); res.write('x'.repeat(512)); res.end('"}'); });
		const config = peer('https://g.example', origin);
		await expect(requestGridspacePeer(config, '/read', {}, 64)).rejects.toThrow();
		await expect(link(config).json('/check', {}, true, 64)).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
	});

	test('never forwards credentials through redirects', async () => {
		let forwarded = false;
		const target = await listen((_req, res) => { forwarded = true; res.end('{}'); });
		const origin = await listen((_req, res) => { res.writeHead(307, { location: target }); res.end(); });
		const config = peer('https://g.example', origin);
		await expect(requestGridspacePeer(config, '/read', { accessToken: 'test-only' })).rejects.toThrow();
		await expect(link(config).json('/check', { accessToken: 'test-only' })).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
		expect(forwarded).toBe(false);
	});

	test('preserves known authorization failures and hides unknown response details', async () => {
		const origin = await listen((req, res) => {
			res.statusCode = 403;
			res.end(JSON.stringify({ error: req.url === '/revoked' ? 'AUTHORIZATION_REVOKED' : 'private response detail' }));
		});
		const config = peer('https://g.example', origin);
		await expect(link(config).json('/revoked', {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		await expect(link(config).json('/unknown', {})).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE', message: 'PEER_UNAVAILABLE' });
		await expect(requestGridspacePeer(config, '/unknown', {})).rejects.toThrow('GridSpace peer unavailable');
	});

	test('aborts a response that stalls after headers', async () => {
		const origin = await listen((_req, res) => { res.writeHead(200); res.write('{"unfinished":'); });
		await expect(requestGridspacePeer(peer('https://g.example', origin), '/read', {}, 1024, Date.now() + 100)).rejects.toMatchObject({ name: 'AbortError' });
	});
});

test('private TLS transport preserves Host and SNI and cannot override the peer origin through a path', () => {
	const config = { ...peer('https://g.example', 'https://r.example'), transportOrigin: 'https://192.168.10.94:3443', transportCa: 'test-ca' };
	const transport = gridspacePeerTransport(config, '/gridspace/v1/history');
	expect(transport.url.href).toBe('https://192.168.10.94:3443/gridspace/v1/history');
	expect(transport.host).toBe('r.example');
	expect(transport.agent?.options.servername).toBe('r.example');
	expect(transport.agent?.options.ca).toBe('test-ca');
	expect(transport.agent?.maxSockets).toBe(Infinity);
	expect(transport.agent?.options.rejectUnauthorized).not.toBe(false);
	for (const path of ['https://evil.example', '//evil.example', '/\\evil.example']) {
		expect(() => gridspacePeerTransport(config, path)).toThrow();
	}
	transport.agent?.destroy();
});
