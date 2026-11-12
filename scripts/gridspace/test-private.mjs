/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, eventually, loadSite, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0);
const r = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
const query = `Private ${suffix}`;
const roles = new Map();
for (const site of [g, r]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	return { ...await api(site, 'admin/accounts/create', { username: `p_${label}_${suffix}`, password }, site.accounts.admin.token), password };
}
async function consent(destination, source, viewer, old, endpoint, finish = true) {
	const started = await api(destination, endpoint, { action: 'start' }, viewer.token);
	const response = await fetch(started.authorizationUrl, { signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 200);
	const html = await response.text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${source.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	assert.equal(callback.origin, destination.origin);
	const input = { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey };
	if (finish) await api(destination, endpoint, input, viewer.token);
	return input;
}
const post = async (site, user, args = {}) => (await api(site, 'notes/create', { text: query, localOnly: true, ...args }, user.token)).createdNote;
const denied = async promise => assert.rejects(promise, error => ['GRIDSPACE_PRIVATE_UNAVAILABLE', 'PERMISSION_DENIED', 'CREDENTIAL_REQUIRED'].includes(error.code));
const read = (viewer, params = {}) => api(g, 'gridspace/private-notes', { mode: 'search', query, ...params }, viewer.token);

try {
	const gu = await account(g, 'g'); const ru = await account(r, 'r');
	const viewer = await account(g, 'v'); const author = await account(r, 'author');
	for (const [site, users] of [[g, [gu, viewer]], [r, [ru, author]]]) {
		const role = await api(site, 'admin/roles/create', {
			name: `Private fixture ${suffix}`, description: 'Temporary API fixture role', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 }, canSearchNotes: { useDefault: false, priority: 2, value: true } },
		}, site.accounts.admin.token);
		roles.set(site, role.id);
		for (const user of users) await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, site.accounts.admin.token);
	}
	await api(r, 'i/update', { isLocked: true }, author.token);
	await api(r, 'following/create', { userId: author.id }, ru.token);
	await api(r, 'following/requests/accept', { userId: ru.id }, author.token);
	await consent(g, r, gu, ru, 'gridspace/link');
	await eventually('Frozen follow copy', async () => (await api(g, 'gridspace/link', {}, gu.token)).pending === 0, 60000);
	const remote = await api(g, 'users/show', { username: author.username, host: new URL(r.origin).host }, gu.token);
	assert.equal(remote.isFollowing, false);
	assert.equal(remote.hasPendingFollowRequestFromYou, true);
	const first = await post(r, author, { visibility: 'followers' });
	const specified = await post(r, author, { visibility: 'specified', visibleUserIds: [ru.id], text: `${query} specified` });
	const hidden = await post(r, author, { visibility: 'specified', visibleUserIds: [author.id], text: `${query} @${ru.username} hidden-only` });
	const cw = await post(r, author, { visibility: 'followers', text: 'Only the content warning matches', cw: query });
	const history = [];
	for (let n = 0; n < 12; n++) {
		const id = (Date.now() - 86400000 - n * 1000 - 946684800000).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
		await r.db.query('INSERT INTO note SELECT (jsonb_populate_record(NULL::note, to_jsonb(n) || $1::jsonb)).* FROM note n WHERE n.id=$2', [JSON.stringify({ id, text: `${query} historical ${n}` }), first.id]);
		history.push(id);
	}
	await denied(read(gu));
	await denied(read(viewer));
	const flow = await consent(g, r, gu, ru, 'gridspace/private-grant', false);
	await denied(api(g, 'gridspace/private-grant', { ...flow, clientKey: 'wrong' }, gu.token));
	await denied(api(g, 'gridspace/private-grant', flow, viewer.token));
	await denied(api(g, 'gridspace/private-grant', { ...flow, issuer: g.origin }, gu.token));
	await api(g, 'gridspace/private-grant', flow, gu.token);
	await denied(api(g, 'gridspace/private-grant', flow, gu.token));
	assert.equal((await api(g, 'gridspace/private-grant', {}, gu.token)).granted, true);
	assert.equal((await api(r, 'gridspace/private-grant', {}, ru.token)).mutual, true, 'One consent must also grant reverse reading');
	console.log('Additional OAuth consent, browser/user/issuer binding, replay and reciprocal consent PASS');

	const seen = []; let page = await read(gu, { limit: 3 }); const cursor = page.cursor;
	assert.ok(cursor);
	await denied(read(gu, { query: 'different query', cursor }));
	await denied(read(viewer, { cursor }));
	for (let n = 0; n < 10; n++) {
		seen.push(...page.notes);
		if (!page.cursor) break;
		page = await read(gu, { limit: 3, cursor: page.cursor });
	}
	const expected = [first.id, specified.id, cw.id, ...history];
	assert.deepEqual(new Set(seen.map(note => note.id)), new Set(expected));
	assert.equal(seen.length, expected.length);
	assert.equal(seen.some(note => note.id === hidden.id), false);
	assert.equal((await read(gu, { query: 'hidden-only', limit: 1 })).cursor, null);
	assert.equal((await read(gu, { query: 'hidden-only', limit: 1 })).notes.length, 0);
	assert.equal((await read(gu, { mode: 'show', query: undefined, noteId: hidden.id })).notes.length, 0);
	const allIds = seen.map(note => note.id);
	assert.equal((await read(gu, { mode: 'validate', contextMode: 'search', ids: allIds })).notes.length, expected.length);
	const profile = await read(gu, { mode: 'profile', query: undefined, userId: remote.id });
	assert.equal(profile.notes.length, 10);
	assert.equal((await read(gu, { mode: 'home', query: undefined })).notes.length, 0, 'Unapproved G follow appeared in home');
	const oldPeer = await api(r, 'users/show', { username: gu.username, host: new URL(g.origin).host }, author.token);
	await api(r, 'following/requests/accept', { userId: oldPeer.id }, author.token);
	await eventually('G follow approval', async () => (await api(g, 'users/show', { userId: remote.id }, gu.token)).isFollowing);
	assert.ok((await read(gu, { mode: 'home', query: undefined })).notes.length);
	await api(g, 'following/delete', { userId: remote.id }, gu.token);
	assert.equal((await read(gu, { mode: 'home', query: undefined })).notes.length, 0);
	assert.ok((await read(gu)).notes.length, 'G unfollow revoked the independent old read permission');
	console.log('Old-only followers/specified notes, CW, historical paging, profile, validation and hidden-match exclusion PASS');

	const weak = await api(g, 'miauth/gen-token', { session: null, permission: ['read:account'], name: `weak-${suffix}` }, gu.token);
	await denied(api(g, 'gridspace/private-notes', { mode: 'search', query }, weak.token));
	const scoped = await api(g, 'miauth/gen-token', { session: null, permission: ['read:gridspace-private'], name: `reader-${suffix}` }, gu.token);
	assert.ok((await api(g, 'gridspace/private-notes', { mode: 'search', query }, scoped.token)).notes.length);
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri = ANY($1)', [expected.map(id => `${r.origin}/notes/${id}`)])).rowCount, 0);
	assert.equal((await api(g, 'gridspace/search', { query }, viewer.token)).notes.length, 0);
	console.log('Caller scope enforcement and no shared note/search-cache import PASS');
	for (const site of [g, r]) {
		await api(site, 'admin/roles/update', { roleId: roles.get(site), policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 }, canSearchNotes: { useDefault: false, priority: 2, value: false } } }, site.accounts.admin.token);
		for (const mode of ['search', 'home', 'profile', 'show', 'validate']) {
			await denied(read(gu, { mode, userId: remote.id, noteId: first.id, ids: [first.id], contextMode: 'search' }));
		}
		await api(site, 'admin/roles/update', { roleId: roles.get(site), policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 }, canSearchNotes: { useDefault: false, priority: 2, value: true } } }, site.accounts.admin.token);
	}
	console.log('Search policies enforced in both servers across every query mode PASS');
	const unknown = await account(r, 'unknown');
	await api(r, 'following/create', { userId: unknown.id }, ru.token);
	const parent = await post(r, author, { visibility: 'public', text: `Parent ${suffix}` });
	const unknownQuery = `UnknownRead_${suffix}`;
	await post(r, unknown, { visibility: 'followers', text: unknownQuery, replyId: parent.id });
	assert.equal((await read(gu, { query: unknownQuery })).notes.length, 1);
	assert.equal((await g.db.query('SELECT id FROM "user" WHERE uri=$1', [`${r.origin}/users/${unknown.id}`])).rowCount, 0);
	await api(g, 'mute/create', { userId: remote.id }, gu.token);
	assert.equal((await read(gu, { query: unknownQuery })).notes.length, 0, 'Muted reply author leaked through an unknown root author');
	await api(g, 'mute/delete', { userId: remote.id }, gu.token);
	const blockedHosts = (await api(g, 'admin/meta', {}, g.accounts.admin.token)).blockedHosts;
	try {
		await api(g, 'admin/update-meta', { blockedHosts: [...blockedHosts, new URL(r.origin).host] }, g.accounts.admin.token);
		assert.equal((await read(gu, { query: unknownQuery })).notes.length, 0, 'Unknown author bypassed destination host block');
	} finally { await api(g, 'admin/update-meta', { blockedHosts }, g.accounts.admin.token); }
	console.log('Unknown author and nested reply respect destination host blocks and mutes PASS');

	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2rSAAAAAASUVORK5CYII=', 'base64');
	const form = new FormData(); form.set('i', author.token); form.set('file', new Blob([png], { type: 'image/png' }), 'private.png');
	const upload = await fetch(`${r.origin}/api/drive/files/create`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
	assert.equal(upload.status, 200); const file = await upload.json();
	const imageNote = await post(r, author, { visibility: 'specified', visibleUserIds: [ru.id], fileIds: [file.id], text: `${query} image`, cw: 'Private image warning', poll: { choices: ['one', 'two'], multiple: false } });
	const detail = (await read(gu, { mode: 'show', query: undefined, noteId: imageNote.id })).notes[0];
	assert.equal(detail.files[0].id, file.id); assert.equal(detail.files[0].url, undefined); assert.equal(detail.poll.choices.length, 2);
	const bytes = await api(g, 'gridspace/private-file', { noteId: imageNote.id, fileId: file.id }, gu.token);
	assert.deepEqual(Buffer.from(bytes.data, 'base64'), png);
	await denied(api(g, 'gridspace/private-file', { noteId: first.id, fileId: file.id }, gu.token));
	await denied(api(g, 'gridspace/private-file', { noteId: imageNote.id, fileId: file.id }, viewer.token));
	await denied(api(g, 'gridspace/private-file', { noteId: imageNote.id, fileId: file.id }, weak.token));
	const cache = await fetch(`${g.origin}/api/gridspace/private-notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: gu.token, mode: 'show', noteId: imageNote.id }) });
	assert.equal(cache.headers.get('cache-control'), 'no-store'); await cache.body.cancel();
	console.log('Attachment membership/authorization, bytes, safe metadata, poll and no-store headers PASS');

	await api(g, 'mute/create', { userId: remote.id }, gu.token);
	assert.equal((await read(gu)).notes.length, 0);
	await denied(api(g, 'gridspace/private-file', { noteId: imageNote.id, fileId: file.id }, gu.token));
	await api(g, 'mute/delete', { userId: remote.id }, gu.token);
	await api(g, 'blocking/create', { userId: remote.id }, gu.token);
	assert.equal((await read(gu)).notes.length, 0);
	await api(g, 'blocking/delete', { userId: remote.id }, gu.token);
	await api(r, 'blocking/create', { userId: ru.id }, author.token);
	assert.equal((await read(gu)).notes.length, 0);
	await api(r, 'blocking/delete', { userId: ru.id }, author.token);
	await api(r, 'following/create', { userId: author.id }, ru.token);
	await api(r, 'following/requests/accept', { userId: ru.id }, author.token);
	await api(r, 'i/update', { makeNotesHiddenBefore: Math.ceil(Date.now() / 1000) + 120 }, author.token);
	assert.equal((await read(gu)).notes.length, 0);
	await api(r, 'i/update', { makeNotesHiddenBefore: null }, author.token);
	await api(r, 'notes/delete', { noteId: specified.id }, author.token);
	assert.equal((await read(gu, { mode: 'show', query: undefined, noteId: specified.id })).notes.length, 0);
	await api(r, 'following/delete', { userId: author.id }, ru.token);
	assert.equal((await read(gu, { mode: 'show', query: undefined, noteId: first.id })).notes.length, 0);
	assert.equal((await read(gu, { mode: 'show', query: undefined, noteId: imageNote.id })).notes.length, 1);
	console.log('G mute, source block, hidden-before, deletion and loss of old follow permission PASS');

	const pending = await consent(g, r, gu, ru, 'gridspace/private-grant', false);
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, gu.token);
	await denied(api(g, 'gridspace/private-grant', pending, gu.token));
	await denied(read(gu));
	assert.equal((await api(r, 'gridspace/private-grant', {}, ru.token)).granted, false);
	assert.equal((await api(g, 'gridspace/link', {}, gu.token)).state, 'active');
	await consent(g, r, gu, ru, 'gridspace/private-grant');
	await denied(read(gu, { cursor }));
	await r.db.query('DELETE FROM access_token WHERE "userId"=$1 AND name=$2', [ru.id, `${g.origin}/gridspace/v1/private-oauth-client`]);
	await denied(read(gu));
	assert.equal((await api(r, 'gridspace/private-grant', {}, ru.token)).granted, false);
	await consent(g, r, gu, ru, 'gridspace/private-grant');
	const reverse = await post(g, gu, { visibility: 'specified', visibleUserIds: [gu.id], text: `${query} reverse` });
	assert.equal((await api(r, 'gridspace/private-notes', { mode: 'show', noteId: reverse.id }, ru.token)).notes[0].id, reverse.id);
	console.log('Read-only revocation, pending callback/cursor invalidation, provider token revocation and reverse reads PASS');
	const stale = await consent(g, r, gu, ru, 'gridspace/private-grant', false);
	await consent(g, r, gu, ru, 'gridspace/link');
	await denied(api(g, 'gridspace/private-grant', stale, gu.token));
	await denied(read(gu));
	assert.equal((await api(r, 'gridspace/private-grant', {}, ru.token)).granted, false);
	await consent(g, r, gu, ru, 'gridspace/private-grant');
	console.log('Link generation change invalidates both read grants and pending consent PASS');

	// Leave a usable authorized fixture for browser verification and manual checks.
	await api(r, 'following/create', { userId: author.id }, ru.token);
	await api(r, 'following/requests/accept', { userId: ru.id }, author.token);
	savePrivateJson(resolve('.config/gridspace-private-test-accounts.json'), { grid: gu, resonite: ru, viewer, author, remote, query, first, imageNote, file, history });
	console.log('Private integration checks passed; browser fixture saved in ignored .config.');
} finally {
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.accounts.admin.token);
	for (const site of [g, r]) await site.db.end();
}
