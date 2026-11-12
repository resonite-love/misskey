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
	return { ...await api(site, 'admin/accounts/create', { username: `actions_${label}_${suffix}`, password }, site.accounts.admin.token), password };
}
async function consent(viewer, old, endpoint, options = {}) {
	const started = await api(g, endpoint, { action: 'start', ...options }, viewer.token);
	if (options.withActions) assert.ok(new URL(started.authorizationUrl).searchParams.get('scope').includes('write:gridspace-actions'));
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
const denied = promise => assert.rejects(promise, error => ['GRIDSPACE_REPLY_UNAVAILABLE', 'GRIDSPACE_ACTION_UNAVAILABLE', 'PERMISSION_DENIED', 'ACCESS_DENIED', 'INVALID_PARAM', 'CREDENTIAL_REQUIRED'].includes(error.code));
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
	await api(r, 'following/create', { userId: author.id }, resonite.token);
	await consent(grid, resonite, 'gridspace/link');
	await eventually('Follow copy', async () => (await api(g, 'gridspace/link', {}, grid.token)).pending === 0, 60000);
	const post = async args => (await api(r, 'notes/create', { text: `Action parent ${suffix}`, visibility: 'specified', visibleUserIds: [resonite.id], localOnly: true, ...args }, author.token)).createdNote;
	const parent = await post({ poll: { choices: ['one', 'two'], multiple: false } });
	const multiple = await post({ poll: { choices: ['one', 'two'], multiple: true } });
	const hidden = await post({ visibleUserIds: [outsider.id] });
	const action = params => api(g, 'gridspace/private-action', { noteId: parent.id, ...params }, grid.token);
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNw2BL1nxLMMGrA/9EwiBoNgy3DIgwAwJVNH4qw1v8AAAAASUVORK5CYII=', 'base64');
	async function upload(site, endpoint, user, extra = {}, data = png) {
		const form = new FormData(); form.set('i', user.token); form.set('file', new Blob([data], { type: 'image/png' }), 'action.png');
		for (const [key, value] of Object.entries(extra)) form.set(key, String(value));
		const response = await fetch(`${site.origin}/api/${endpoint}`, { method: 'POST', body: form });
		const result = await response.json();
		if (!response.ok) throw Object.assign(new Error(`Upload failed: ${result.error?.code}`), { code: result.error?.code });
		if (endpoint.startsWith('gridspace/')) assert.equal(response.headers.get('cache-control'), 'no-store');
		return result;
	}
	await consent(grid, resonite, 'gridspace/private-grant', { withReply: true, withNotifications: true });
	assert.equal((await action({})).canInteract, false);
	assert.equal((await api(g, 'gridspace/private-reply', { noteId: parent.id }, grid.token)).canAttach, false);
	await denied(action({ action: 'react', reaction: '👍' }));
	await denied(upload(g, 'gridspace/private-upload', grid, { noteId: parent.id, name: 'action.png' }));
	await consent(grid, resonite, 'gridspace/private-grant', { withActions: true });
	const status = await api(g, 'gridspace/private-grant', {}, grid.token);
	assert.equal(status.canInteract, true); assert.equal(status.canReply, true); assert.equal(status.canReadNotifications, true);
	assert.equal((await api(r, 'gridspace/private-grant', {}, resonite.token)).canInteract, false);
	console.log('Explicit action consent preserves prior scopes; reverse grant stays read-only PASS');

	await Promise.all(Array.from({ length: 6 }, () => action({ action: 'react', reaction: '👍' })));
	let rows = (await r.db.query('SELECT * FROM note_reaction WHERE "noteId"=$1 AND "userId"=$2', [parent.id, resonite.id])).rows;
	assert.equal(rows.length, 1); assert.equal(rows[0].reaction, '👍');
	assert.equal((await action({})).note.myReaction, '👍');
	await action({ action: 'react', reaction: '🎉' });
	await Promise.all([action({ action: 'react', reaction: null }), action({ action: 'react', reaction: null })]);
	assert.equal((await action({})).note.myReaction, null);
	await denied(action({ action: 'react', reaction: '👍', noteId: hidden.id }));
	const weak = await api(g, 'miauth/gen-token', { session: null, permission: ['write:gridspace-actions'], name: 'action-caller' }, grid.token);
	await denied(api(g, 'gridspace/private-action', { noteId: parent.id, action: 'react', reaction: '👍' }, weak.token));
	console.log('Source identity, idempotent reaction set/change/delete, hidden note and session-only API PASS');

	await Promise.all(Array.from({ length: 6 }, () => action({ action: 'vote', choice: 0 })));
	rows = (await r.db.query('SELECT * FROM poll_vote WHERE "noteId"=$1 AND "userId"=$2', [parent.id, resonite.id])).rows;
	assert.equal(rows.length, 1);
	assert.equal((await action({})).note.poll.choices[0].isVoted, true);
	await denied(action({ action: 'vote', choice: 1 }));
	await denied(action({ action: 'vote', choice: 99 }));
	await action({ action: 'vote', noteId: multiple.id, choice: 0 });
	await action({ action: 'vote', noteId: multiple.id, choice: 1 });
	assert.ok((await action({ noteId: multiple.id })).note.poll.choices.every(choice => choice.isVoted));
	const expired = await post({ poll: { choices: ['one', 'two'], multiple: false } });
	await r.db.query('UPDATE poll SET "expiresAt"=$1 WHERE "noteId"=$2', [new Date(Date.now() - 1000), expired.id]);
	await denied(action({ action: 'vote', noteId: expired.id, choice: 0 }));
	// The ordinary endpoint uses the same atomic vote path and preserves its errors.
	await api(r, 'notes/polls/vote', { noteId: parent.id, choice: 1 }, author.token);
	await assert.rejects(api(r, 'notes/polls/vote', { noteId: parent.id, choice: 0 }, author.token), error => error.code === 'ALREADY_VOTED');
	assert.deepEqual((await r.db.query('SELECT votes FROM poll WHERE "noteId"=$1', [parent.id])).rows[0].votes, [1, 1]);
	console.log('Single/multiple/expired/invalid votes, concurrent retry and ordinary vote endpoint PASS');

	const file = await upload(g, 'gridspace/private-upload', grid, { noteId: parent.id, name: 'action.png', comment: 'private attachment', isSensitive: true });
	const sourceFile = (await r.db.query('SELECT * FROM drive_file WHERE id=$1', [file.id])).rows[0];
	assert.equal(sourceFile.userId, resonite.id); assert.equal(sourceFile.comment, 'private attachment'); assert.equal(sourceFile.isSensitive, true);
	const wrongFile = await upload(r, 'drive/files/create', outsider);
	await denied(api(g, 'gridspace/private-reply', { action: 'send', noteId: parent.id, requestId: randomUUID(), fileIds: [wrongFile.id] }, grid.token));
	const request = { action: 'send', noteId: parent.id, requestId: randomUUID(), text: '', fileIds: [file.id] };
	const replies = await Promise.all(Array.from({ length: 4 }, () => api(g, 'gridspace/private-reply', request, grid.token)));
	assert.ok(replies.every(reply => reply.createdNoteId === replies[0].createdNoteId));
	const reply = (await r.db.query('SELECT * FROM note WHERE id=$1', [replies[0].createdNoteId])).rows[0];
	assert.equal(reply.userId, resonite.id); assert.equal(reply.visibility, 'specified'); assert.equal(reply.localOnly, true);
	assert.deepEqual(reply.fileIds, [file.id]); assert.equal(reply.text, null);
	assert.deepEqual(new Set(reply.visibleUserIds), new Set([resonite.id, author.id]));
	await denied(api(g, 'gridspace/private-reply', { ...request, text: 'changed' }, grid.token));
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [`${r.origin}/notes/${reply.id}`])).rowCount, 0);
	console.log('Source drive ownership, wrong-owner rejection, attachment-only reply, audience and retry PASS');

	const emojiFile = await upload(r, 'drive/files/create', { token: r.accounts.admin.token });
	const emojiName = `action_${suffix}`;
	await api(r, 'admin/emoji/add', { fileId: emojiFile.id, name: emojiName }, r.accounts.admin.token);
	const formatted = await post({ text: `**MFM body** :${emojiName}: @${resonite.username}`, cw: `CW :${emojiName}:`, poll: { choices: [`:${emojiName}:`, 'plain'], multiple: false } });
	const packed = (await action({ noteId: formatted.id })).note;
	assert.ok(packed.emojis[emojiName]?.startsWith('https://')); assert.ok(packed.text.includes('**MFM body**'));
	await action({ noteId: formatted.id, action: 'react', reaction: `:${emojiName}:` });
	assert.equal((await action({ noteId: formatted.id })).note.myReaction, `:${emojiName}@.:`);
	console.log('Custom source emoji in body/CW/poll and custom reaction PASS');

	await api(r, 'blocking/create', { userId: resonite.id }, author.token);
	await denied(action({ action: 'react', reaction: '👍' }));
	await api(r, 'blocking/delete', { userId: resonite.id }, author.token);
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, grid.token);
	await denied(action({ action: 'react', reaction: '👍' }));
	await consent(grid, resonite, 'gridspace/private-grant', { withActions: true });
	const sourceToken = (await r.db.query('SELECT token FROM access_token WHERE "userId"=$1 AND permission @> ARRAY[\'write:gridspace-actions\']::varchar[]', [resonite.id])).rows[0].token;
	await assert.rejects(api(r, 'notes/reactions/create', { noteId: parent.id, reaction: '👍' }, sourceToken), error => ['PERMISSION_DENIED', 'AUTHENTICATION_FAILED'].includes(error.code));
	const freshPoll = await post({ poll: { choices: ['browser one', 'browser two'], multiple: false } });
	savePrivateJson(resolve('.config/gridspace-actions-test-accounts.json'), { grid, resonite, author, outsider, parent, formatted, freshPoll, emojiName });
	console.log('Block/revoke and narrow OAuth token restrictions PASS');
} finally {
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.accounts.admin.token).catch(() => {});
	for (const site of [g, r]) await site.db.end();
}
