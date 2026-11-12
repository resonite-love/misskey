/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { createGridspaceHeaders, resolveGridspaceConfig } from '../../packages/backend/src/core/gridspace/peer-protocol.ts';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
for (const site of [g, r]) {
	site.admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
	const env = Object.fromEntries(readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').trim().split(/\r?\n/).map(line => {
		const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
	}));
	site.peer = resolveGridspaceConfig(site.config.gridspace, site.origin, env);
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, database: site.config.db.db, password: env.GRIDSPACE_LAB_DB_PASSWORD });
	await site.db.connect();
}
const account = (site, label) => api(site, 'admin/accounts/create', { username: `rv_${label}_${suffix}`, password: randomBytes(24).toString('base64url') }, site.admin.token);
async function consent(viewer, old, endpoint, options = {}) {
	const start = await api(g, endpoint, { action: 'start', ...options }, viewer.token);
	const html = await (await fetch(start.authorizationUrl)).text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	await api(g, endpoint, { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: start.clientKey }, viewer.token);
}
try {
	const viewer = await account(g, 'g'); const old = await account(r, 'old'); const next = await account(r, 'new');
	await consent(viewer, old, 'gridspace/link');
	await consent(viewer, old, 'gridspace/private-grant', { withNotifications: true });
	const previous = (await g.db.query('SELECT id, generation FROM gridspace_link WHERE "localUserId"=$1 AND state=\'active\'', [viewer.id])).rows[0];
	await api(g, 'gridspace/link', { action: 'revoke' }, viewer.token);
	await consent(viewer, next, 'gridspace/link');
	await consent(viewer, next, 'gridspace/private-grant', { withNotifications: true });
	const pending = await api(g, 'gridspace/private-grant', { action: 'start', withNotifications: true }, viewer.token);
	assert.ok(pending.authorizationUrl);
	const tokens = () => g.db.query('SELECT id FROM access_token WHERE "userId"=$1 ORDER BY id', [viewer.id]).then(result => result.rows);
	const sessions = () => g.db.query('SELECT id FROM gridspace_auth_session WHERE "localUserId"=$1 ORDER BY id', [viewer.id]).then(result => result.rows);
	const beforeTokens = await tokens(); const beforeSessions = await sessions();
	assert.ok(beforeTokens.length > 0); assert.ok(beforeSessions.length > 0);
	const path = '/gridspace/v1/link/revoke';
	const body = Buffer.from(JSON.stringify({ linkId: previous.id, generation: previous.generation, localUserId: old.id }));
	for (let n = 0; n < 2; n++) {
		const response = await fetch(g.origin + path, { method: 'POST', body, headers: createGridspaceHeaders(r.peer, 'POST', path, body) });
		assert.equal(response.status, 200);
		assert.deepEqual(await tokens(), beforeTokens, 'delayed old revoke deleted current tokens');
		assert.deepEqual(await sessions(), beforeSessions, 'delayed old revoke deleted pending consent');
		const current = await api(g, 'gridspace/link', {}, viewer.token);
		assert.equal(current.state, 'active'); assert.equal(current.peerUserId, next.id);
		assert.equal((await api(g, 'gridspace/private-grant', {}, viewer.token)).canReadNotifications, true);
		assert.equal((await api(g, 'gridspace/notifications', { source: 'peer', countOnly: true }, viewer.token)).recipientId, next.id);
	}
	console.log('Delayed duplicate revocation preserves a new link, current tokens, pending consent and actual private access PASS');
} finally { await Promise.all([g.db.end(), r.db.end()]); }
