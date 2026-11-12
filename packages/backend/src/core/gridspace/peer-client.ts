/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createGridspaceHeaders, type GridspacePeerConfig } from './peer-protocol.js';

export async function requestGridspacePeer(peer: GridspacePeerConfig, path: string, input: object, maxBytes = 2 * 1024 * 1024, deadline?: number): Promise<unknown> {
	const bytes = Buffer.from(JSON.stringify(input));
	const response = await fetch(peer.peerOrigin + path, {
		method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(20000, (deadline ?? Date.now() + 20000) - Date.now()))),
		headers: createGridspaceHeaders(peer, 'POST', path, bytes),
	});
	if (!response.ok) { await response.body?.cancel(); throw new Error('GridSpace peer unavailable'); }
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Empty peer response');
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.length;
			if (size > maxBytes) { await reader.cancel(); throw new Error('Peer response too large'); }
			chunks.push(part.value);
		}
	} finally { reader.releaseLock(); }
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
