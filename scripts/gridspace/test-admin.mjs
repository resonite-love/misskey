/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, eventually, loadSite, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0); const r = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
// Use the application's HTTP/1.1 transport when killing/restarting its peer.
// Native fetch may retain an HTTP/2 session connected to the terminated server.
globalThis.fetch = createRequire(resolve('packages/backend/package.json'))('node-fetch').default;
const suffix = randomBytes(4).toString('hex'); const roles = new Map();
for (const site of [g, r]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
const adminApi = (path, body = {}, site = g) => api(site, `admin/gridspace/${path}`, body, site.accounts.admin.token);
const control = action => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/gridspace/server-control.ps1'), '-Action', action, '-Repository', r.repo], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
async function ready(site) { await eventually(`${site.role} ready`, async () => { try { await api(site, 'ping'); return true; } catch { return false; } }, 60000); }
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	const user = { ...await api(site, 'admin/accounts/create', { username: `ops_${label}_${suffix}`, password }, site.accounts.admin.token), password };
	await api(site, 'admin/roles/assign', { roleId: roles.get(site), userId: user.id }, site.accounts.admin.token);
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	return user;
}
async function consent(viewer, old, endpoint = 'gridspace/link') {
	const started = await api(g, endpoint, { action: 'start' }, viewer.token);
	const page = await fetch(started.authorizationUrl, { signal: AbortSignal.timeout(15000) });
	assert.equal(page.status, 200);
	const transaction = (await page.text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
	const response = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 302); const callback = new URL(response.headers.get('location'));
	await api(g, endpoint, { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, viewer.token);
}
let stopped = false;
try {
	await ready(g); await ready(r);
	for (const site of [g, r]) {
		const role = await api(site, 'admin/roles/create', { name: `ops_${suffix}`, description: 'Temporary operations test role', color: null, iconUrl: null, target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } } }, site.accounts.admin.token);
		roles.set(site, role.id);
		assert.equal((await adminApi('status', {}, site)).connection, 'ok');
		for (const [endpoint, params] of [['status', {}], ['links', {}], ['jobs', {}], ['retry', { kind: 'import', id: randomUUID(), generation: 1 }]]) {
			await assert.rejects(api(site, `admin/gridspace/${endpoint}`, params, site.accounts.reader.token));
			await assert.rejects(api(site, `admin/gridspace/${endpoint}`, params));
		}
	}
	const viewer = await account(g, 'viewer'); const old = await account(r, 'old');
	const target = await account(g, 'target'); const source = await account(r, 'source'); const extra = await account(r, 'extra');
	await api(r, 'following/create', { userId: source.id }, old.token);
	await consent(viewer, old);
	await eventually('initial copy complete', async () => (await api(g, 'gridspace/link', { action: 'status' }, viewer.token)).pending === 0);
	const link = (await adminApi('links', { userId: viewer.id })).items[0];
	assert.equal(link.localUserId, viewer.id);
	const serialized = JSON.stringify(link);
	assert.ok(!/token|cipher|snapshot|verifier/i.test(serialized));
	const importId = randomUUID(); const cancelledId = randomUUID();
	await g.db.query('INSERT INTO gridspace_import_item (id,"linkId","actorUri","withReplies",state,reason) VALUES ($1,$2,$3,false,\'failed\',\'FOLLOW_FAILED\'),($4,$2,$5,false,\'cancelled\',\'USER_UNFOLLOWED\')', [importId, link.id, `${r.origin}/users/${extra.id}`, cancelledId, `${r.origin}/users/cancelled-${suffix}`]);
	const first = await adminApi('jobs', { kind: 'import', userId: viewer.id, failedOnly: false, limit: 1 });
	assert.equal(first.items.length, 1); assert.ok(first.next);
	const second = await adminApi('jobs', { kind: 'import', userId: viewer.id, failedOnly: false, limit: 1, after: first.next });
	assert.notEqual(second.items[0].id, first.items[0].id);
	assert.equal((await adminApi('retry', { kind: 'import', id: importId, generation: link.generation + 1 })).retried, false);
	assert.equal((await adminApi('retry', { kind: 'import', id: cancelledId, generation: link.generation })).retried, false);
	assert.equal((await adminApi('retry', { kind: 'import', id: importId, generation: link.generation })).retried, true);
	await eventually('retried import completed', async () => (await g.db.query('SELECT state FROM gridspace_import_item WHERE id=$1', [importId])).rows[0].state !== 'pending');
	assert.equal((await adminApi('retry', { kind: 'import', id: importId, generation: link.generation })).retried, false);
	assert.equal((await g.db.query('SELECT COUNT(*)::int AS count FROM moderation_log WHERE type=\'retryGridspaceJob\' AND info->>\'jobId\'=$1', [importId])).rows[0].count, 1);
	console.log('G/R admin-only access, safe DTO, pagination, generation checks, cancelled imports and atomic retry audit PASS');

	await g.db.query('INSERT INTO gridspace_follow_expansion ("followerId","targetId",state,reason,"retryAt",attempts) VALUES ($1,$2,\'pending\',\'FOLLOW_FAILED\',NOW()+interval \'1 hour\',1)', [viewer.id, target.id]);
	await consent(target, source);
	const expansionId = `${viewer.id}:${target.id}`;
	assert.equal((await adminApi('jobs', { kind: 'expansion', userId: viewer.id })).items.find(item => item.id === expansionId).canRetry, true);
	assert.equal((await adminApi('retry', { kind: 'expansion', id: expansionId })).retried, true);
	await eventually('retried expansion followed target', async () => (await api(g, 'users/show', { userId: target.id }, viewer.token)).isFollowing);
	assert.equal((await adminApi('retry', { kind: 'expansion', id: expansionId })).retried, false);
	console.log('Failed automatic follow retries through normal follow service without duplication PASS');
	await consent(viewer, old, 'gridspace/private-grant');
	const secret = (await api(r, 'notes/create', { text: `ops private ${suffix}`, visibility: 'followers' }, source.token)).createdNote;
	assert.ok((await api(g, 'gridspace/private-notes', { mode: 'show', noteId: secret.id }, viewer.token)).notes.length);
	savePrivateJson(resolve('.config/gridspace-admin-test-accounts.json'), { viewer, old, target, source, extra });
	control('stop'); stopped = true;
	assert.equal((await adminApi('status')).connection, 'unavailable');
	await assert.rejects(api(g, 'gridspace/private-notes', { mode: 'show', noteId: secret.id }, viewer.token), error => error.code === 'GRIDSPACE_PRIVATE_UNAVAILABLE');
	const keep = (await api(g, 'notes/create', { text: `ops retained ${suffix}` }, viewer.token)).createdNote;
	const remove = (await api(g, 'notes/create', { text: `ops deleted ${suffix}` }, viewer.token)).createdNote;
	await eventually('delivery failure recorded', async () => (await adminApi('jobs', { kind: 'delivery', userId: viewer.id })).items.some(item => item.id === remove.id), 60000);
	const failed = (await adminApi('jobs', { kind: 'delivery', userId: viewer.id })).items.find(item => item.id === remove.id);
	assert.equal((await adminApi('retry', { kind: 'delivery', id: remove.id, version: randomUUID() })).retried, false);
	await api(g, 'notes/delete', { noteId: remove.id }, viewer.token);
	assert.equal((await adminApi('retry', { kind: 'delivery', id: remove.id, version: failed.version })).retried, false);
	await eventually('retained delivery eligible', async () => (await adminApi('jobs', { kind: 'delivery', userId: viewer.id })).items.some(item => item.id === keep.id && item.canRetry), 60000);
	const retained = (await adminApi('jobs', { kind: 'delivery', userId: viewer.id })).items.find(item => item.id === keep.id);
	assert.equal((await adminApi('retry', { kind: 'delivery', id: keep.id, version: retained.version })).retried, true);
	await api(g, 'gridspace/link', { action: 'revoke' }, viewer.token);
	assert.ok((await adminApi('status')).revocationsPending > 0);
	console.log('Stopped R: diagnostics, private-read denial, failed delivery retry and delete-version protection PASS');
	control('start'); stopped = false; await ready(r);
	await eventually('revocation reaches recovered R', async () => (await api(r, 'gridspace/link', { action: 'status' }, old.token)).state === 'revoked', 60000);
	await eventually('retained note delivered once', async () => (await r.db.query('SELECT COUNT(*)::int AS count FROM note WHERE uri=$1', [`${g.origin}/notes/${keep.id}`])).rows[0].count === 1, 60000);
	await eventually('deleted note delivery cleared', async () => (await g.db.query('SELECT 1 FROM gridspace_note_delivery WHERE "noteId"=$1', [remove.id])).rowCount === 0, 60000);
	assert.equal((await r.db.query('SELECT 1 FROM note WHERE uri=$1', [`${g.origin}/notes/${remove.id}`])).rowCount, 0);
	await assert.rejects(api(g, 'gridspace/private-notes', { mode: 'show', noteId: secret.id }, viewer.token));
	assert.equal((await adminApi('status')).connection, 'ok');
	console.log('Recovered R: durable deliveries, no deleted-note resurrection, revocation and ordinary access restored PASS');
} finally {
	if (stopped) { control('start'); await ready(r); }
	for (const site of [g, r]) {
		try { if (roles.has(site)) await api(site, 'admin/roles/delete', { roleId: roles.get(site) }, site.accounts.admin.token); } finally { await site.db.end(); }
	}
}
