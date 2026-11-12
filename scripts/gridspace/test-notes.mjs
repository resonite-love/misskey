/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, eventually, loadSite } from './lab.mjs';
import { createGridspaceHeaders, resolveGridspaceConfig } from '../../packages/backend/src/core/gridspace/peer-protocol.ts';

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
async function account(site, label) {
	return api(site, 'admin/accounts/create', { username: `n_${label.slice(0, 3)}_${suffix}`, password: randomBytes(24).toString('base64url') }, site.accounts.admin.token);
}
const uri = (site, note) => `${site.origin}/notes/${note.id}`;
const timeline = (site, endpoint, user) => api(site, `notes/${endpoint}`, { limit: 100 }, user.token);
const find = async (site, source, note) => (await site.db.query(`SELECT id, "localOnly", ${site.role === 'E' ? 'false AS' : ''} "gridspaceShared" FROM note WHERE uri=$1`, [uri(source, note)])).rows[0];
const post = async (site, user, args = {}) => (await api(site, 'notes/create', { text: `GridSpace notes ${suffix}`, localOnly: true, ...args }, user.token)).createdNote;
async function delivered(site, source, note) {
	await eventually('peer note received', () => find(site, source, note), 60000);
	return find(site, source, note);
}
async function stream(site, user, channels) {
	const received = new Map(channels.map(channel => [channel, []]));
	const connected = new Set();
	const socket = new WebSocket(`${site.origin.replace('https:', 'wss:')}/streaming?i=${encodeURIComponent(user.token)}`);
	await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
	socket.on('message', data => {
		const event = JSON.parse(String(data));
		if (event.type === 'connected') connected.add(event.body.id);
		if (event.type === 'channel' && event.body.type === 'note') received.get(event.body.id)?.push(event.body.body);
	});
	for (const channel of channels) socket.send(JSON.stringify({ type: 'connect', body: { channel, id: channel, pong: true } }));
	await eventually('stream channels connected', () => channels.every(channel => connected.has(channel)));
	return { socket, received };
}
const sockets = [];
try {
	const author = await account(r, 'author');
	const reader = await account(g, 'reader');
	const outsider = await account(g, 'outsider');
	const external = await account(e, 'external');
	const remote = await api(g, 'users/show', { username: author.username, host: new URL(r.origin).host }, reader.token);
	await api(g, 'following/create', { userId: remote.id }, reader.token);
	const externalAuthor = await api(e, 'users/show', { username: author.username, host: new URL(r.origin).host }, external.token);
	await api(e, 'following/create', { userId: externalAuthor.id }, external.token);
	await eventually('follow accepted before streaming', async () => (await api(g, 'users/show', { userId: remote.id }, reader.token)).isFollowing);
	await eventually('external follow accepted', async () => (await api(e, 'users/show', { userId: externalAuthor.id }, external.token)).isFollowing);
	const live = await stream(g, reader, ['localTimeline', 'homeTimeline', 'hybridTimeline']); sockets.push(live.socket);
	const publicNote = await post(r, author);
	const copy = await delivered(g, r, publicNote);
	assert.equal(copy.localOnly, true); assert.equal(copy.gridspaceShared, true);
	for (const channel of ['localTimeline', 'homeTimeline', 'hybridTimeline']) await eventually(`${channel} public note`, async () => live.received.get(channel).some(note => note.uri === uri(r, publicNote)));
	assert.ok((await timeline(g, 'local-timeline', outsider)).some(note => note.id === copy.id));
	assert.ok((await timeline(g, 'timeline', reader)).some(note => note.id === copy.id));
	assert.ok(!(await timeline(g, 'timeline', outsider)).some(note => note.id === copy.id));
	const home = await post(r, author, { visibility: 'home' });
	const homeCopy = await delivered(g, r, home);
	assert.ok((await timeline(g, 'timeline', reader)).some(note => note.id === homeCopy.id));
	assert.ok(!(await timeline(g, 'local-timeline', reader)).some(note => note.id === homeCopy.id));
	assert.ok(!(await timeline(g, 'timeline', outsider)).some(note => note.id === homeCopy.id));
	console.log('Local-only public/home: database, LTL/home/hybrid streams, followed and unfollowed views PASS');

	const reply = await post(g, reader, { replyId: copy.id, localOnly: false });
	const quote = await post(g, reader, { renoteId: copy.id, localOnly: false });
	assert.equal(reply.localOnly, true); assert.equal(quote.localOnly, true);
	await delivered(r, g, reply); await delivered(r, g, quote);
	for (const [site, note] of [[r, publicNote], [r, home], [g, reply], [g, quote]]) {
		assert.equal((await fetch(uri(site, note), { headers: { accept: 'application/activity+json' }, redirect: 'manual' })).status, 404);
		assert.equal(await find(e, site, note), undefined);
	}
	console.log('Bidirectional replies/quotes inherit local-only; external AP retrieval and delivery blocked PASS');

	const privateNote = await post(r, author, { visibility: 'followers' });
	const directNote = await post(r, author, { visibility: 'specified', visibleUserIds: [r.accounts.reader.id] });
	const normal = await post(r, author, { localOnly: false });
	await delivered(g, r, normal); await delivered(e, r, normal);
	await eventually('ordinary AP + peer dedup LTL', async () => (await timeline(g, 'local-timeline', outsider)).some(note => note.uri === uri(r, normal)));
	assert.equal((await g.db.query('SELECT count(*)::int AS count FROM note WHERE uri=$1', [uri(r, normal)])).rows[0].count, 1);
	assert.equal(await find(g, r, privateNote), undefined); assert.equal(await find(g, r, directNote), undefined);
	const normalRenote = await post(r, author, { localOnly: false, text: null, renoteId: normal.id });
	await delivered(g, r, normalRenote);
	await eventually('ordinary external Renote delivered', async () => (await e.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, normalRenote) + '/activity'])).rowCount === 1);
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=ANY($1)', [[uri(r, normalRenote), uri(r, normalRenote) + '/activity']])).rowCount, 1);
	await eventually('Renote peer delivery acknowledged', async () => (await r.db.query('SELECT 1 FROM gridspace_note_delivery WHERE "noteId"=$1', [normalRenote.id])).rowCount === 0);
	// Suppress the peer deletion for this disposable fixture to exercise ordinary AP Undo alone.
	await r.db.query('UPDATE note SET "gridspaceShared"=false WHERE id=$1 AND "userId"=$2', [normalRenote.id, author.id]);
	await api(r, 'notes/delete', { noteId: normalRenote.id }, author.token);
	await eventually('AP Undo resolves canonical Renote', async () => !await find(g, r, normalRenote));
	console.log('Private local-only excluded; ordinary federation still works and canonical URI deduplicates PASS');

	const upload = new FormData();
	upload.set('i', author.token);
	upload.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'bridge.png');
	const uploaded = await fetch(r.origin + '/api/drive/files/create', { method: 'POST', body: upload });
	assert.equal(uploaded.status, 200);
	const file = await uploaded.json();
	const media = await post(r, author, { cw: 'test CW', fileIds: [file.id], poll: { choices: ['one', 'two'], multiple: false, expiredAfter: 3600000 } });
	const mediaCopy = await delivered(g, r, media);
	const packedMedia = await api(g, 'notes/show', { noteId: mediaCopy.id }, reader.token);
	assert.equal(packedMedia.cw, 'test CW'); assert.equal(packedMedia.files.length, 1); assert.equal(packedMedia.poll.choices.length, 2);
	const withFiles = await api(g, 'notes/local-timeline', { withFiles: true }, reader.token);
	assert.ok(withFiles.some(note => note.id === mediaCopy.id));
	const renote = await post(g, reader, { text: null, renoteId: copy.id, localOnly: false });
	assert.equal(renote.localOnly, true); await delivered(r, g, renote);
	console.log('CW, image, initial poll, file-only LTL and pure Renote PASS');

	const originalMeta = await api(g, 'admin/meta', {}, g.accounts.admin.token);
	try {
		await api(g, 'admin/update-meta', { enableFanoutTimeline: false }, g.accounts.admin.token);
		assert.ok((await timeline(g, 'local-timeline', reader)).some(note => note.id === copy.id));
		assert.ok((await timeline(g, 'timeline', reader)).some(note => note.id === homeCopy.id));
	} finally {
		await api(g, 'admin/update-meta', { enableFanoutTimeline: originalMeta.enableFanoutTimeline }, g.accounts.admin.token);
	}
	console.log('Database timeline fallback PASS');

	await api(g, 'mute/create', { userId: remote.id }, outsider.token);
	await eventually('mute/block hides shared note', async () => !(await timeline(g, 'local-timeline', outsider)).some(note => note.id === copy.id));
	await api(g, 'mute/delete', { userId: remote.id }, outsider.token);
	const remoteOutsider = await api(r, 'users/show', { username: outsider.username, host: new URL(g.origin).host }, author.token);
	await api(r, 'blocking/create', { userId: remoteOutsider.id }, author.token);
	await eventually('mute/block hides shared note', async () => !(await timeline(g, 'local-timeline', outsider)).some(note => note.id === copy.id));
	console.log('Mute/block filters retained PASS');

	const linked = JSON.parse(readFileSync(resolve(g.repo, '.config/gridspace-link-test-accounts.json'), 'utf8'));
	const own = await post(r, linked.resonite, { visibility: 'home' });
	const ownCopy = await delivered(g, r, own);
	await eventually('linked own home', async () => (await timeline(g, 'timeline', linked.grid)).some(note => note.id === ownCopy.id));
	console.log('Linked old account home without following self PASS');

	await api(r, 'notes/delete', { noteId: publicNote.id }, author.token);
	await eventually('peer delete', async () => !await find(g, r, publicNote));
	const env = Object.fromEntries(readFileSync(resolve(r.repo, '.config/gridspace-lab.env'), 'utf8').trim().split(/\r?\n/).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
	const peer = resolveGridspaceConfig(r.config.gridspace, r.origin, env);
	const path = '/gridspace/v1/notes/sync'; const body = Buffer.from(JSON.stringify({ noteId: publicNote.id }));
	assert.equal((await fetch(g.origin + path, { method: 'POST', body, headers: createGridspaceHeaders(peer, 'POST', path, body) })).status, 200);
	assert.equal(await find(g, r, publicNote), undefined);
	console.log('Delete propagation and redelivery do not resurrect notes PASS');

	await api(r, 'admin/accounts/delete', { userId: author.id }, r.accounts.admin.token);
	await eventually('account deletion also removes peer notes', async () => !await find(g, r, home), 60000);
	console.log('Account deletion propagates PASS');
} finally {
	for (const socket of sockets) socket.close();
	await Promise.all([g, r, e].map(site => site.db.end()));
}
