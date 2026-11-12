/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Agent } from 'node:https';
import fetch from 'node-fetch';
import type { Readable } from 'node:stream';
import { createGridspaceHeaders, type GridspacePeerConfig } from './peer-protocol.js';

export class GridspaceProtocolMismatch extends Error {}
export class GridspaceEndpointUnavailable extends Error {}

const agents = new WeakMap<GridspacePeerConfig, Agent>();

/** The route may be private, but Host, SNI, actor URLs and signatures stay canonical. */
export function gridspacePeerTransport(peer: GridspacePeerConfig, path: string) {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || new URL(path, peer.peerOrigin).origin !== peer.peerOrigin) throw new Error('Invalid peer path');
	let agent = agents.get(peer);
	if (peer.transportOrigin && !agent) {
		// Reciprocal authorization callbacks must never queue behind requests waiting
		// for those same callbacks. Bound idle sockets, not active sockets.
		agent = new Agent({ keepAlive: true, maxFreeSockets: 4, timeout: 20000,
			servername: new URL(peer.peerOrigin).hostname, ...(peer.transportCa ? { ca: peer.transportCa } : {}) });
		agents.set(peer, agent);
	}
	return { url: new URL(path, peer.transportOrigin ?? peer.peerOrigin), agent, host: new URL(peer.peerOrigin).host };
}

export async function requestGridspacePeer(peer: GridspacePeerConfig, path: string, input: object, maxBytes = 2 * 1024 * 1024, deadline?: number): Promise<unknown> {
	const bytes = Buffer.from(JSON.stringify(input));
	// Match HttpRequestService's HTTP/1.1 transport. Native fetch can negotiate HTTP/2
	// and queue reciprocal POSTs behind a sync waiting for those same requests.
	const transport = gridspacePeerTransport(peer, path);
	const response = await fetch(transport.url, {
		agent: transport.agent,
		method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(20000, (deadline ?? Date.now() + 20000) - Date.now()))),
		size: maxBytes,
		headers: { ...createGridspaceHeaders(peer, 'POST', path, bytes), host: transport.host },
	});
	if (!response.ok) {
		// Only recognize this fixed handshake error; never expose an arbitrary peer body.
		if (path === '/gridspace/v1/handshake' && response.status === 409) {
			let body: unknown;
			try { body = await response.json(); } catch { /* Invalid or oversized response. */ }
			if (body && typeof body === 'object' && 'error' in body && body.error === 'PEER_PROTOCOL_INCOMPATIBLE') throw new GridspaceProtocolMismatch('GridSpace protocol mismatch');
		}
		(response.body as Readable | null)?.destroy();
		if (response.status === 404) throw new GridspaceEndpointUnavailable('GridSpace peer endpoint unavailable');
		throw new Error('GridSpace peer unavailable');
	}
	// node-fetch enforces size while consuming the body, including chunked responses.
	return response.json();
}
