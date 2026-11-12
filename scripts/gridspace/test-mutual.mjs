/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { createGridspaceHeaders, resolveGridspaceConfig } from '../../packages/backend/src/core/gridspace/peer-protocol.ts';
import { gridspaceHash, openGridspaceSecret, sealGridspaceSecret } from '../../packages/backend/src/core/gridspace/link-crypto.ts';

// Dedicated lab only. Seed the exact durable state at network boundaries, then
// exercise the real endpoints to reproduce lost responses and late delivery.
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-private-test-accounts.json', 'utf8'));
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const roles = new Map();
g.user = fixture.grid; r.user = fixture.resonite;
for (const site of [g, r]) {
	const env = Object.fromEntries(readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').trim().split(/\r?\n/).map(line => {
		const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
	}));
	site.peer = resolveGridspaceConfig(site.config.gridspace, site.origin, env);
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password: env.GRIDSPACE_LAB_DB_PASSWORD, database: site.config.db.db });
	await site.db.connect();
}
async function consent(destination = g, source = r, finish = true) {
	const started = await api(destination, 'gridspace/private-grant', { action: 'start' }, destination.user.token);
	const response = await fetch(started.authorizationUrl, { signal: AbortSignal.timeout(15000) });
	const transaction = (await response.text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${source.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction, login_token: source.user.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	const input = { action: 'finish', state: callback.searchParams.get('state'), code: callback.searchParams.get('code'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey };
	if (finish) await api(destination, 'gridspace/private-grant', input, destination.user.token);
	return input;
}
async function peer(action, input) {
	const path = `/gridspace/v1/private/${action}`; const body = Buffer.from(JSON.stringify(input));
	const response = await fetch(r.origin + path, { method: 'POST', body, headers: createGridspaceHeaders(g.peer, 'POST', path, body), signal: AbortSignal.timeout(15000) });
	return { status: response.status, body: await response.json() };
}
const link = async site => (await site.db.query('SELECT * FROM gridspace_link WHERE "localUserId"=$1 AND state=\'active\'', [site.user.id])).rows[0];
const denied = promise => assert.rejects(promise, error => error.code === 'GRIDSPACE_PRIVATE_UNAVAILABLE');
async function both(granted) {
	for (const site of [g, r]) {
		const status = await api(site, 'gridspace/private-grant', {}, site.user.token);
		assert.equal(status.granted, granted, `${site.role} grant state`);
		if (granted) assert.equal(status.mutual, true);
	}
}
async function stage() {
	const current = await link(g); const source = await link(r);
	const input = await consent(g, r, false);
	const session = (await g.db.query('SELECT * FROM gridspace_auth_session WHERE "stateHash"=$1', [gridspaceHash(input.state)])).rows[0];
	const exchange = await fetch(`${r.origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
		body: JSON.stringify({ grant_type: 'authorization_code', code: input.code, client_id: `${g.origin}/gridspace/v1/private-oauth-client`, redirect_uri: `${g.origin}/settings/gridspace`,
			code_verifier: openGridspaceSecret(g.peer, session.verifierCipher, session.id) }),
	});
	assert.equal(exchange.status, 200);
	const { access_token: accessToken } = await exchange.json();
	const pairId = session.id; const reverseToken = randomBytes(32).toString('base64url');
	const reverseId = (Date.now() - 946684800000).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
	await g.db.query('INSERT INTO access_token (id, token, hash, "userId", name, permission, fetched) VALUES ($1,$2,$2,$3,$4,$5,true)', [reverseId, reverseToken, g.user.id, `${r.origin}/gridspace/v1/private-oauth-client`, ['read:gridspace-private']]);
	await g.db.query('UPDATE gridspace_auth_session SET "tokenCipher"=$1, exchanged=true, "privateGrant"=$2 WHERE id=$3',
		[sealGridspaceSecret(g.peer, accessToken, pairId), { reverseTokenId: reverseId, expectedPeerRevision: source.privateRevision }, pairId]);
	await g.db.query('UPDATE gridspace_link SET "privateMutualGrantId"=$1, "privateTokenHash"=$2, "privateMutualReady"=false, "privateRevision"="privateRevision"+1, "privateTokenCipher"=$4 WHERE id=$3',
		[pairId, gridspaceHash(reverseToken), current.id, sealGridspaceSecret(g.peer, accessToken, `private:${current.id}:${current.generation}`)]);
	return {
		input, reverseId,
		wire: { linkId: current.id, generation: current.generation, localUserId: g.user.id, accessToken, pairId, reverseToken, expectedRevision: source.privateRevision },
	};
}
try {
	for (const site of [g, r]) {
		const admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
		site.admin = admin;
		const role = await api(site, 'admin/roles/create', {
			name: `Mutual fixture ${randomUUID()}`, description: 'Temporary concurrency test role', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } },
		}, admin.token);
		roles.set(site, role.id);
		await api(site, 'admin/roles/assign', { roleId: role.id, userId: site.user.id }, admin.token);
	}
	await consent();
	await both(true);
	const previous = await Promise.all([g, r].map(async site => {
		const active = await link(site);
		return (await site.db.query('SELECT id, token FROM access_token WHERE "userId"=$1 AND encode(sha256(convert_to(token,\'UTF8\')),\'hex\')=$2', [site.user.id, active.privateTokenHash])).rows[0];
	}));
	await consent();
	for (const [index, site] of [g, r].entries()) assert.equal((await site.db.query('SELECT count(*)::int AS n FROM access_token WHERE id=$1', [previous[index].id])).rows[0].n, 0);
	const orphanId = (Date.now() - 946684800000).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
	const orphanToken = randomBytes(32).toString('base64url');
	try {
		await g.db.query('INSERT INTO access_token (id, token, hash, "userId", name, permission, fetched) VALUES ($1,$2,$2,$3,$4,$5,true)', [orphanId, orphanToken, g.user.id, `${r.origin}/gridspace/v1/private-oauth-client`, ['read:gridspace-private']]);
		await denied(api(g, 'gridspace/private-notes', { mode: 'search', query: fixture.query }, orphanToken));
		await denied(api(g, 'gridspace/private-file', { noteId: fixture.imageNote.id, fileId: fixture.file.id }, orphanToken));
	} finally { await g.db.query('DELETE FROM access_token WHERE id=$1', [orphanId]); }
	const beforeRevoke = await link(g);
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, g.user.token);
	assert.equal((await g.db.query('SELECT count(*)::int AS n FROM access_token WHERE "userId"=$1 AND encode(sha256(convert_to(token,\'UTF8\')),\'hex\')=$2', [g.user.id, beforeRevoke.privateTokenHash])).rows[0].n, 0);
	await consent();
	console.log('Replacement/revocation delete bound tokens; orphaned peer tokens cannot use general private APIs PASS');
	let pending = await stage();
	await both(false);
	await api(g, 'gridspace/private-grant', pending.input, g.user.token);
	await both(true);
	await denied(api(g, 'gridspace/private-grant', pending.input, g.user.token));
	const miauth = await fetch(`${g.origin}/api/miauth/${pending.wire.pairId}/check`, { method: 'POST', signal: AbortSignal.timeout(15000) });
	assert.equal('token' in await miauth.json(), false);
	console.log('Prepared grant retries once; incomplete pairs deny reads; MiAuth cannot retrieve reverse token PASS');

	pending = await stage();
	assert.equal((await peer('reciprocal', pending.wire)).status, 200);
	await both(false);
	assert.notEqual((await peer('reciprocal', { ...pending.wire, reverseToken: 'changed' })).status, 200);
	await api(g, 'gridspace/private-grant', pending.input, g.user.token);
	await both(true);
	console.log('Lost reciprocal response retries idempotently; changed payload rejected PASS');

	pending = await stage();
	await g.db.query('DELETE FROM access_token WHERE id=$1', [pending.reverseId]);
	await denied(api(g, 'gridspace/private-grant', pending.input, g.user.token));
	assert.equal((await g.db.query('SELECT count(*)::int AS n FROM access_token WHERE id=$1', [pending.reverseId])).rows[0].n, 0);
	await both(false);
	await consent();
	console.log('Deleted reverse token is never recreated on retry PASS');

	pending = await stage();
	await api(r, 'gridspace/private-grant', { action: 'revoke' }, r.user.token);
	assert.notEqual((await peer('reciprocal', pending.wire)).status, 200);
	await both(false);
	await consent();
	console.log('Peer revocation after probe rejects stale reciprocal delivery PASS');

	pending = await stage();
	await g.db.query('DELETE FROM gridspace_auth_session WHERE id=$1', [pending.wire.pairId]);
	assert.equal((await peer('reciprocal', pending.wire)).status, 200);
	await denied(api(g, 'gridspace/private-grant', pending.input, g.user.token));
	await both(false);
	await consent();
	console.log('Cancelled prepared session cannot become readable through late peer delivery PASS');

	// Existing ordinary scopes must not acquire reciprocal permission.
	const current = await link(g);
	const accessToken = openGridspaceSecret(g.peer, current.privateTokenCipher, `private:${current.id}:${current.generation}`);
	const row = (await r.db.query('SELECT id, permission FROM access_token WHERE token=$1', [accessToken])).rows[0];
	try {
		await r.db.query('UPDATE access_token SET permission=$1 WHERE id=$2', [['read:gridspace-private'], row.id]);
		assert.notEqual((await peer('mutual-probe', { linkId: current.id, generation: current.generation, localUserId: g.user.id, accessToken })).status, 200);
	} finally { await r.db.query('UPDATE access_token SET permission=$1 WHERE id=$2', [row.permission, row.id]); }
	console.log('Legacy scope cannot authorize reciprocal access PASS');

	for (const site of [g, r]) {
		const active = await link(site);
		const token = (await site.db.query('SELECT id FROM access_token WHERE "userId"=$1 AND encode(sha256(convert_to(token,\'UTF8\')),\'hex\')=$2', [site.user.id, active.privateTokenHash])).rows[0];
		assert.ok(token);
		await api(site, 'i/revoke-token', { tokenId: token.id }, site.user.token);
		await both(false);
		await consent();
	}
	console.log('Native token revocation on either server stops both directions PASS');

	const first = await consent(g, r, false); const second = await consent(r, g, false);
	await Promise.allSettled([api(g, 'gridspace/private-grant', first, g.user.token), api(r, 'gridspace/private-grant', second, r.user.token)]);
	const statuses = await Promise.all([g, r].map(site => api(site, 'gridspace/private-grant', {}, site.user.token)));
	assert.equal(statuses[0].granted, statuses[1].granted);
	await consent(); await both(true);
	console.log('Concurrent opposite flows complete without deadlock and recover with fresh consent PASS');
} finally {
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.admin.token);
	for (const site of [g, r]) await site.db.end();
}
