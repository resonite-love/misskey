/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, eventually, loadSite, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0); const r = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
const roles = new Map();
for (const site of [g, r]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	return { ...await api(site, 'admin/accounts/create', { username: `reply_${label}_${suffix}`, password }, site.accounts.admin.token), password };
}
async function consent(viewer, old, endpoint, withReply = false) {
	const started = await api(g, endpoint, { action: 'start', withReply }, viewer.token);
	assert.equal(new URL(started.authorizationUrl).searchParams.get('scope').includes('write:gridspace-reply'), withReply);
	const response = await fetch(started.authorizationUrl, { signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 200);
	const transaction = (await response.text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	await api(g, endpoint, { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, viewer.token);
}
const denied = promise => assert.rejects(promise, error => ['GRIDSPACE_REPLY_UNAVAILABLE', 'PERMISSION_DENIED', 'INVALID_PARAM', 'CREDENTIAL_REQUIRED'].includes(error.code));
try {
	const grid = await account(g, 'g'); const resonite = await account(r, 'r');
	const author = await account(r, 'a'); const outsider = await account(r, 'x');
	for (const [site, users] of [[g, [grid]], [r, [resonite, author, outsider]]]) {
		const role = await api(site, 'admin/roles/create', {
			name: `Reply fixture ${suffix}`, description: 'Temporary reply fixture role', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 }, canSearchNotes: { useDefault: false, priority: 2, value: true } },
		}, site.accounts.admin.token);
		roles.set(site, role.id);
		for (const user of users) await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, site.accounts.admin.token);
	}
	await api(r, 'i/update', { isLocked: true }, author.token);
	await api(r, 'following/create', { userId: author.id }, resonite.token);
	await api(r, 'following/requests/accept', { userId: resonite.id }, author.token);
	await consent(grid, resonite, 'gridspace/link');
	await eventually('Follow copy', async () => (await api(g, 'gridspace/link', {}, grid.token)).pending === 0, 60000);
	const post = async args => (await api(r, 'notes/create', { text: `Reply parent ${suffix}`, ...args }, author.token)).createdNote;
	const followers = await post({ visibility: 'followers' });
	const specified = await post({ visibility: 'specified', visibleUserIds: [resonite.id] });
	const local = await post({ visibility: 'specified', visibleUserIds: [resonite.id], localOnly: true });
	const hidden = await post({ visibility: 'specified', visibleUserIds: [outsider.id] });
	const reply = (params, token = grid.token) => api(g, 'gridspace/private-reply', params, token);
	const send = noteId => ({ action: 'send', noteId, requestId: randomUUID(), text: `Reply ${suffix}` });
	await consent(grid, resonite, 'gridspace/private-grant');
	assert.equal((await reply({ noteId: specified.id })).canReply, false);
	await denied(reply(send(specified.id)));
	assert.equal((await api(g, 'gridspace/private-grant', {}, grid.token)).canReply, false);
	await consent(grid, resonite, 'gridspace/private-grant', true);
	assert.equal((await api(g, 'gridspace/private-grant', {}, grid.token)).canReply, true);
	assert.equal((await api(r, 'gridspace/private-grant', {}, resonite.token)).canReply, false);
	console.log('Explicit write consent, read-only rejection and reverse read-only grant PASS');
	const prepared = await reply({ noteId: specified.id });
	assert.equal(prepared.account.username, resonite.username);
	assert.equal(prepared.visibility, 'specified');
	assert.deepEqual(new Set(prepared.recipients.map(user => user.username)), new Set([resonite.username, author.username]));
	const body = { ...send(specified.id), text: `Reply ${suffix} @${outsider.username}`, cw: 'reply warning' };
	const concurrent = await Promise.all(Array.from({ length: 6 }, () => reply(body)));
	const created = concurrent[0].createdNoteId;
	assert.ok(created);
	assert.ok(concurrent.every(result => result.createdNoteId === created));
	const row = (await r.db.query('SELECT * FROM note WHERE id=$1', [created])).rows[0];
	assert.equal(row.userId, resonite.id); assert.equal(row.replyId, specified.id);
	assert.equal(row.visibility, 'specified'); assert.equal(row.localOnly, false); assert.equal(row.cw, body.cw);
	assert.deepEqual(new Set(row.visibleUserIds), new Set([resonite.id, author.id]));
	assert.deepEqual(new Set(row.mentions), new Set([resonite.id, author.id]));
	assert.equal(row.mentions.includes(outsider.id), false);
	assert.equal((await r.db.query('SELECT id FROM note WHERE "userId"=$1 AND text=$2', [resonite.id, body.text])).rowCount, 1);
	assert.equal((await reply({ action: 'status', noteId: specified.id, requestId: body.requestId })).createdNoteId, created);
	assert.equal((await reply({ action: 'status', noteId: specified.id, requestId: randomUUID() })).createdNoteId, null);
	await denied(reply({ ...body, text: 'different payload' }));
	const weak = await api(g, 'miauth/gen-token', { session: null, permission: ['read:gridspace-private'], name: 'reply-read-only' }, grid.token);
	await denied(reply(send(specified.id), weak.token));
	const sourceToken = (await r.db.query('SELECT token FROM access_token WHERE "userId"=$1 AND permission @> ARRAY[\'write:gridspace-reply\']::varchar[]', [resonite.id])).rows[0]?.token;
	assert.ok(sourceToken);
	await denied(api(r, 'gridspace/private-reply', send(specified.id), sourceToken));
	const cached = await fetch(`${g.origin}/api/gridspace/private-reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: grid.token, noteId: specified.id }) });
	assert.equal(cached.headers.get('cache-control'), 'no-store'); await cached.body.cancel();
	console.log('Source identity, fixed recipients, no outsider mention delivery, concurrent retry, status and caller scopes PASS');
	for (const parent of [followers, local]) {
		const result = await reply(send(parent.id));
		const note = (await r.db.query('SELECT * FROM note WHERE id=$1', [result.createdNoteId])).rows[0];
		assert.equal(note.visibility, parent.visibility); assert.equal(note.localOnly, parent.localOnly);
		assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [`${r.origin}/notes/${note.id}`])).rowCount, 0);
	}
	for (const invalid of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(3001) }, { cw: 'x'.repeat(101) }]) await denied(reply({ ...send(specified.id), ...invalid }));
	await denied(reply(send(hidden.id)));
	await api(r, 'notes/delete', { noteId: created }, resonite.token);
	await denied(reply(body));
	assert.equal((await r.db.query('SELECT * FROM gridspace_reply_receipt WHERE "requestId"=$1', [body.requestId])).rowCount, 1);
	console.log('Visibility/local-only inheritance, length limits, hidden parent rejection and deleted-reply replay prevention PASS');
	const remote = await api(g, 'users/show', { username: author.username, host: new URL(r.origin).host }, grid.token);
	await api(g, 'mute/create', { userId: remote.id }, grid.token);
	await denied(reply(send(specified.id)));
	await api(g, 'mute/delete', { userId: remote.id }, grid.token);
	await api(r, 'following/delete', { userId: author.id }, resonite.token);
	await denied(reply(send(followers.id)));
	await api(r, 'following/create', { userId: author.id }, resonite.token);
	await api(r, 'following/requests/accept', { userId: resonite.id }, author.token);
	await r.db.query('UPDATE "user" SET "movedToUri"=$2 WHERE id=$1', [resonite.id, `${r.origin}/users/${outsider.id}`]);
	try { await denied(reply(send(specified.id))); } finally { await r.db.query('UPDATE "user" SET "movedToUri"=NULL WHERE id=$1', [resonite.id]); }
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, grid.token);
	await denied(reply(send(specified.id)));
	await consent(grid, resonite, 'gridspace/private-grant');
	assert.equal((await reply({ noteId: specified.id })).canReply, false);
	console.log('Destination mute, lost source follow, moved account, revocation and read-only reauthorization PASS');
	savePrivateJson(resolve('.config/gridspace-reply-test-accounts.json'), { grid, resonite, author, outsider, followers, specified, local });
} finally {
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.accounts.admin.token);
	for (const site of [g, r]) await site.db.end();
}
