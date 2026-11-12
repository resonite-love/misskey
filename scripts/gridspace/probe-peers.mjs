/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGridspaceHeaders, GRIDSPACE_HANDSHAKE_PATH, resolveGridspaceConfig } from '../../packages/backend/src/core/gridspace/peer-protocol.ts';

const configPath = resolve('.config/gridspace-lab.yml');
const source = JSON.parse(readFileSync(configPath, 'utf8'));
const env = Object.fromEntries(readFileSync(resolve('.config/gridspace-lab.env'), 'utf8').trim().split(/\r?\n/).map(line => {
	const separator = line.indexOf('=');
	return [line.slice(0, separator), line.slice(separator + 1)];
}));
const first = resolveGridspaceConfig(source.gridspace, source.url, env);
if (!first) throw new Error('Run this from a linked test repository.');
const second = { ...first, origin: first.peerOrigin, peerOrigin: first.origin };

for (const config of [first, second]) {
	const body = Buffer.from(JSON.stringify({ protocolVersion: 1 }));
	const headers = createGridspaceHeaders(config, 'POST', GRIDSPACE_HANDSHAKE_PATH, body);
	const send = candidateHeaders => fetch(new URL(GRIDSPACE_HANDSHAKE_PATH, config.peerOrigin), {
		method: 'POST', body, headers: candidateHeaders, redirect: 'error', signal: AbortSignal.timeout(15000),
	});
	const response = await send(headers);
	assert.equal(response.status, 200, `Handshake failed for ${config.peerOrigin}`);
	const capabilities = await response.json();
	assert.equal(capabilities.origin, config.peerOrigin);
	assert.equal(capabilities.peerOrigin, config.origin);
	assert.equal(capabilities.communityId, config.communityId);
	assert.equal(capabilities.protocolVersion, 1);
	assert.equal((await send(headers)).status, 409, 'Replayed request was accepted');
	assert.equal((await send({ ...headers, 'x-gridspace-signature': 'invalid' })).status, 403, 'Invalid signature was accepted');
	console.log(`${config.origin} -> ${config.peerOrigin}: authenticated / replay rejected / invalid signature rejected`);
}
