/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { api, eventually, loadSite, savePrivateJson } from './lab.mjs';

const phase = process.argv[2];
assert.ok(['prepare', 'during', 'after'].includes(phase), 'Use prepare, during or after');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-private-test-accounts.json', 'utf8'));
const read = params => api(g, 'gridspace/private-notes', { mode: 'search', query: fixture.query, limit: 3, ...params }, fixture.grid.token);
const denied = promise => assert.rejects(promise, error => error.code === 'GRIDSPACE_PRIVATE_UNAVAILABLE');
const statePath = resolve('.config/gridspace-private-outage.json');

if (phase === 'prepare') {
	const page = await read(); assert.ok(page.notes.length && page.cursor);
	savePrivateJson(statePath, { cursor: page.cursor });
} else if (phase === 'during') {
	await denied(read());
	await denied(api(g, 'gridspace/private-file', { noteId: fixture.imageNote.id, fileId: fixture.file.id }, fixture.grid.token));
	const status = await api(g, 'gridspace/private-grant', {}, fixture.grid.token);
	assert.equal(status.granted, true); assert.equal(status.available, false);
	await denied(api(g, 'gridspace/private-grant', { action: 'revoke' }, fixture.grid.token));
	await denied(read());
	assert.equal((await api(g, 'gridspace/private-grant', {}, fixture.grid.token)).granted, false);
	console.log('Stopped peer fails closed for private notes/files; offline revocation immediately disables local reads PASS');
} else {
	await eventually('Peer recovery', async () => { try { await api(r, 'ping'); return true; } catch { return false; } }, 60000);
	await denied(read());
	assert.equal((await api(r, 'gridspace/private-grant', {}, fixture.resonite.token)).granted, false);
	let started;
	await eventually('Queued grant revocation delivered', async () => {
		try { started = await api(g, 'gridspace/private-grant', { action: 'start' }, fixture.grid.token); return true; } catch { return false; }
	}, 60000);
	const html = await (await fetch(started.authorizationUrl, { signal: AbortSignal.timeout(15000) })).text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
	const response = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction, login_token: fixture.resonite.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 302); const callback = new URL(response.headers.get('location'));
	await api(g, 'gridspace/private-grant', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, fixture.grid.token);
	assert.ok((await read()).notes.length);
	assert.equal((await api(r, 'gridspace/private-grant', {}, fixture.resonite.token)).mutual, true);
	await denied(read({ cursor: JSON.parse(readFileSync(statePath, 'utf8')).cursor }));
	console.log('Recovery delivers pending revocation; only fresh consent enables reads, and the old cursor stays invalid PASS');
}
