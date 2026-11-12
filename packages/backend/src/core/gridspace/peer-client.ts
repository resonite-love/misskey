/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import fetch from 'node-fetch';
import type { Readable } from 'node:stream';
import { createGridspaceHeaders, type GridspacePeerConfig } from './peer-protocol.js';

export async function requestGridspacePeer(peer: GridspacePeerConfig, path: string, input: object, maxBytes = 2 * 1024 * 1024, deadline?: number): Promise<unknown> {
	const bytes = Buffer.from(JSON.stringify(input));
	// Match HttpRequestService's HTTP/1.1 transport. Native fetch can negotiate HTTP/2
	// and queue reciprocal POSTs behind a sync waiting for those same requests.
	const response = await fetch(peer.peerOrigin + path, {
		method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(20000, (deadline ?? Date.now() + 20000) - Date.now()))),
		size: maxBytes,
		headers: createGridspaceHeaders(peer, 'POST', path, bytes),
	});
	if (!response.ok) { (response.body as Readable | null)?.destroy(); throw new Error('GridSpace peer unavailable'); }
	// node-fetch enforces size while consuming the body, including chunked responses.
	return response.json();
}
