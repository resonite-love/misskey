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
const e = loadSite(process.argv[3] ?? '../gridspace-external-test', 2);
const require = createRequire(resolve('packages/backend/package.json'));
const { Client } = require('pg');
const WebSocket = require('ws');
const suffix = randomBytes(5).toString('hex');
for (const site of [g, r, e]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
const uri = (site, note) => `${site.origin}/notes/${note.id}`;
const canon = (site, note) => note.uri ?? uri(site, note);
const post = async (site, user, args = {}) => (await api(site, 'notes/create', { text: `History ${suffix}`, localOnly: true, ...args }, user.token)).createdNote;
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	return { ...await api(site, 'admin/accounts/create', { username: `h_${label}_${suffix}`, password }, site.accounts.admin.token), password };
}
async function link(gu, ru) {
	const started = await api(g, 'gridspace/link', { action: 'start' }, gu.token);
	const html = await (await fetch(started.authorizationUrl)).text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)[1];
	const response = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: ru.token }) });
	assert.equal(response.status, 302);
	const callback = new URL(response.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, gu.token);
}
// Dedicated test DB only: clone a fixture note into a historical row without creating a delivery event.
async function historical(site, template, date, patch = {}) {
	assert.equal(site.config.id, 'aidx');
	const id = (date - 946684800000).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
	const row = { id, gridspaceShared: false, text: `Old ${site.role} ${suffix}`, ...patch };
	await site.db.query('INSERT INTO note SELECT (jsonb_populate_record(NULL::note, to_jsonb(n) || $1::jsonb)).* FROM note n WHERE n.id=$2', [JSON.stringify(row), template.id]);
	return { ...template, ...row, date };
}
async function collect(site, userId, token, first, betweenPages) {
	const result = [];
	let page = first;
	for (let i = 0; i < 40; i++) {
		page ??= await api(site, 'gridspace/history', { userId, limit: 3 }, token);
		result.push(...page.notes);
		if (!page.cursor) return result;
		if (betweenPages) { await betweenPages(); betweenPages = null; }
		page = await api(site, 'gridspace/history', { userId, limit: 3, cursor: page.cursor }, token);
	}
	throw new Error('History did not terminate');
}
let socket;
try {
	const gu = await account(g, 'g'); const ru = await account(r, 'r'); const viewer = await account(g, 'v');
	await link(gu, ru);
	savePrivateJson(resolve('.config/gridspace-history-test-accounts.json'), { grid: gu, resonite: ru, viewer });
	const remote = await api(g, 'users/show', { username: ru.username, host: new URL(r.origin).host }, viewer.token);
	await api(g, 'following/create', { userId: remote.id }, viewer.token);
	await eventually('history viewer follow accepted', async () => (await api(g, 'users/show', { userId: remote.id }, viewer.token)).isFollowing);
	await api(g, 'following/update', { userId: remote.id, notify: 'normal' }, viewer.token);
	const gt = await post(g, gu); const rt = await post(r, ru);
	const date = Date.now() - 86400000;
	const old = [];
	for (const [site, template, offsets] of [[g, gt, [9000, 8000, 7000, 6000, 3000]], [r, rt, [5000, 4000, 3000, 2000, 1000]]]) {
		for (const offset of offsets) old.push({ site, note: await historical(site, template, date + offset, { visibility: offset === 2000 ? 'home' : 'public', text: 'same text' }) });
	}
	const collision = old.find(x => x.site === g && x.note.date === date + 3000).note.id;
	const collided = old.find(x => x.site === r && x.note.date === date + 3000).note;
	await r.db.query('UPDATE note SET id=$1 WHERE id=$2', [collision, collided.id]); collided.id = collision;
	const hidden = await historical(r, rt, date, { visibility: 'followers' });
	await api(g, 'notes/delete', { noteId: gt.id }, gu.token);
	await api(r, 'notes/delete', { noteId: rt.id }, ru.token);
	await eventually('templates removed from peer', async () => (await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, rt)])).rowCount === 0);
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, old.find(x => x.site === r).note)])).rowCount, 0);
	const member = await api(g, 'gridspace/member', { userId: gu.id }, viewer.token);
	assert.equal(member.linked, true); assert.equal(member.available, true); assert.equal(member.accounts.length, 2);
	assert.deepEqual(new Set(member.accounts.map(x => x.id)), new Set([gu.id, remote.id]));
	assert.equal((await api(g, 'gridspace/member', { userId: remote.id }, viewer.token)).linked, true);
	assert.equal((await api(r, 'gridspace/member', { userId: ru.id }, ru.token)).linked, true);
	assert.equal((await api(g, 'gridspace/member', { userId: viewer.id }, viewer.token)).linked, false);

	const received = [];
	socket = new WebSocket(`${g.origin.replace('https:', 'wss:')}/streaming?i=${encodeURIComponent(viewer.token)}`);
	await new Promise((yes, no) => { socket.once('open', yes); socket.once('error', no); });
	socket.on('message', data => received.push(JSON.parse(String(data))));
	socket.send(JSON.stringify({ type: 'connect', body: { channel: 'homeTimeline', id: 'history', pong: true } }));
	await eventually('history stream subscribed', () => received.some(x => x.type === 'connected'));
	const first = await api(g, 'gridspace/history', { userId: gu.id, limit: 3 }, viewer.token);
	assert.equal(first.notes.length, 3); assert.ok(first.notes.every(n => n.userId === gu.id));
	let fresh;
	const all = await collect(g, gu.id, viewer.token, first, async () => { fresh = await post(r, ru, { text: `New after snapshot ${suffix}` }); });
	assert.equal(all.length, old.length);
	assert.equal(new Set(all.map(n => canon(g, n))).size, old.length);
	for (const item of old) assert.ok(all.some(n => canon(g, n) === uri(item.site, item.note)));
	assert.ok(!all.some(n => n.uri === uri(r, hidden) || n.uri === uri(r, fresh)));
	assert.ok(all.every((n, i) => i === 0 || new Date(all[i - 1].createdAt) >= new Date(n.createdAt)));
	assert.ok(all.filter(n => n.userId === remote.id).every(n => n.localOnly === true && n.user.host === new URL(r.origin).host));
	const oldUris = new Set(old.map(x => uri(x.site, x.note)));
	assert.ok(!received.some(x => x.type === 'channel' && x.body.type === 'note' && oldUris.has(x.body.body.uri)));
	const notifications = await api(g, 'i/notifications', { limit: 100, markAsRead: false }, viewer.token);
	assert.ok(!notifications.some(n => n.note && oldUris.has(n.note.uri)));
	console.log('Linked profiles, old local-only/home history, same IDs/text, snapshot paging and silent import PASS');

	await assert.rejects(api(g, 'gridspace/history', { userId: gu.id, cursor: first.cursor }, gu.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
	await assert.rejects(api(g, 'gridspace/history', { userId: gu.id, cursor: first.cursor, withFiles: true }, viewer.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
	await assert.rejects(api(g, 'gridspace/history', { userId: remote.id, cursor: first.cursor }, viewer.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
	// Actor URI is indexed but not unique. Duplicate cache rows must not break history.
	const aliasId = 'alias' + suffix;
	await g.db.query('INSERT INTO "user" (id, username, "usernameLower", host, uri) VALUES ($1,$2,$2,$3,$4)', [aliasId, aliasId, new URL(r.origin).host, `${r.origin}/users/${ru.id}`]);
	try {
		assert.ok((await api(g, 'gridspace/history', { userId: gu.id, limit: 3 }, viewer.token)).notes.length > 0);
	} finally { await g.db.query('DELETE FROM "user" WHERE id=$1', [aliasId]); }
	console.log('Duplicate cached actor URIs preserve history availability PASS');
	const reverse = await collect(r, ru.id, ru.token);
	assert.ok(old.every(x => reverse.some(n => canon(r, n) === uri(x.site, x.note))));
	for (const item of old.filter(x => x.site === r)) {
		assert.equal((await fetch(uri(r, item.note), { headers: { accept: 'application/activity+json' } })).status, 404);
		assert.equal((await e.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, item.note)])).rowCount, 0);
	}
	await api(g, 'mute/create', { userId: remote.id }, viewer.token);
	assert.ok((await collect(g, gu.id, viewer.token)).every(n => n.userId === gu.id));
	await api(g, 'mute/delete', { userId: remote.id }, viewer.token);
	const viewerOnR = await api(r, 'users/show', { username: viewer.username, host: new URL(g.origin).host }, ru.token);
	await api(r, 'blocking/create', { userId: viewerOnR.id }, ru.token);
	assert.ok((await collect(g, gu.id, viewer.token)).every(n => n.userId === gu.id));
	await api(r, 'blocking/delete', { userId: viewerOnR.id }, ru.token);
	const deleted = old.find(x => x.site === r).note;
	await api(r, 'notes/delete', { noteId: deleted.id }, ru.token);
	await eventually('historical deletion propagated', async () => (await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, deleted)])).rowCount === 0);
	assert.ok(!(await collect(g, gu.id, viewer.token)).some(n => n.uri === uri(r, deleted)));
	console.log('Cursor binding, reverse history, external non-disclosure, mute/block and historical deletion PASS');

	await api(r, 'gridspace/link', { action: 'revoke' }, ru.token);
	assert.equal((await api(g, 'gridspace/member', { userId: gu.id }, viewer.token)).linked, false);
	await assert.rejects(api(g, 'gridspace/history', { userId: gu.id, cursor: first.cursor }, viewer.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
	await link(gu, ru);
	await assert.rejects(api(g, 'gridspace/history', { userId: gu.id, cursor: first.cursor }, viewer.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
	console.log('Unlink/relink invalidates history cursors PASS');

	const external = await account(e, 'e');
	const externalNote = await post(e, external, { localOnly: false, text: `External reference ${suffix}` });
	const externalOnR = (await api(r, 'ap/show', { uri: uri(e, externalNote) }, ru.token)).object;
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(e, externalNote)])).rowCount, 0);
	const privateTemplate = await post(r, ru, { visibility: 'specified', visibleUserIds: [ru.id] });
	const quote = await historical(r, privateTemplate, date - 1000, { visibility: 'public', renoteId: externalOnR.id, renoteUserId: externalOnR.userId, renoteUserHost: new URL(e.origin).host, text: `Historical quote ${suffix}` });
	const renote = await historical(r, privateTemplate, date - 2000, { visibility: 'public', renoteId: externalOnR.id, renoteUserId: externalOnR.userId, renoteUserHost: new URL(e.origin).host, text: null });
	const reply = await historical(r, privateTemplate, date - 3000, { visibility: 'public', replyId: externalOnR.id, replyUserId: externalOnR.userId, replyUserHost: new URL(e.origin).host });
	const upload = new FormData(); upload.set('i', ru.token);
	upload.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'history.png');
	const file = await (await fetch(r.origin + '/api/drive/files/create', { method: 'POST', body: upload })).json();
	assert.ok(file.id);
	const photo = await historical(r, privateTemplate, date - 4000, { visibility: 'home', fileIds: [file.id], cw: 'Historical CW' });
	const extras = await collect(g, gu.id, viewer.token);
	assert.equal(extras.find(n => n.uri === uri(r, quote))?.renote?.uri, uri(e, externalNote));
	assert.equal(extras.find(n => n.uri === uri(r, renote))?.renote?.uri, uri(e, externalNote));
	assert.equal(extras.find(n => n.uri === uri(r, reply))?.reply?.uri, uri(e, externalNote));
	assert.equal(extras.find(n => n.uri === uri(r, photo))?.cw, 'Historical CW');
	assert.equal(extras.find(n => n.uri === uri(r, photo))?.files.length, 1);
	const filtered = await api(g, 'gridspace/history', { userId: gu.id, limit: 20, withReplies: false, withRenotes: false }, viewer.token);
	assert.ok(filtered.notes.some(n => n.uri === uri(r, quote)));
	assert.ok(!filtered.notes.some(n => n.uri === uri(r, renote) || n.uri === uri(r, reply)));
	const photos = await api(g, 'gridspace/history', { userId: gu.id, withFiles: true }, viewer.token);
	assert.deepEqual(photos.notes.map(n => n.uri), [uri(r, photo)]);
	console.log('Historical external reply/quote/Renote, CW, attachments and filters PASS');

	const freshViewer = await account(g, 'new');
	const oldGPolicy = (await g.db.query('SELECT "ugcVisibilityForVisitor" FROM meta')).rows[0].ugcVisibilityForVisitor;
	const oldRPolicy = (await r.db.query('SELECT "ugcVisibilityForVisitor" FROM meta')).rows[0].ugcVisibilityForVisitor;
	try {
		await api(g, 'admin/update-meta', { ugcVisibilityForVisitor: 'all' }, g.accounts.admin.token);
		await api(r, 'admin/update-meta', { ugcVisibilityForVisitor: 'none' }, r.accounts.admin.token);
		const authenticated = await collect(g, gu.id, freshViewer.token);
		assert.ok(authenticated.some(n => n.uri === uri(r, reply)), 'Uncached authenticated viewer lost a public reply');
		const anonymous = await collect(g, gu.id, undefined);
		assert.ok(anonymous.every(n => n.userId === gu.id), 'Anonymous visitor bypassed source policy');
	} finally {
		await api(g, 'admin/update-meta', { ugcVisibilityForVisitor: oldGPolicy }, g.accounts.admin.token);
		await api(r, 'admin/update-meta', { ugcVisibilityForVisitor: oldRPolicy }, r.accounts.admin.token);
	}
	console.log('Uncached authenticated viewer and per-server anonymous policies PASS');
} finally {
	socket?.close();
	await Promise.all([g, r, e].map(site => site.db.end()));
}
