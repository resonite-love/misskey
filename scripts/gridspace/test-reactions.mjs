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
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
const roles = new Map();
const fixtures = [];
for (const site of [g, r, e]) await eventually(`${site.role} ready`, async () => { try { await api(site, 'ping'); return true; } catch { return false; } }, 30000);
for (const site of [g, r, e]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
const post = async (site, user, args = {}) => (await api(site, 'notes/create', { text: `Paired reactions ${suffix}`, ...args }, user.token)).createdNote;
const find = async (site, source, note) => (await site.db.query('SELECT id FROM note WHERE uri=$1', [`${source.origin}/notes/${note.id}`])).rows[0];
async function delivered(site, source, note) {
	await eventually('peer note received', () => find(site, source, note), 60000);
	return find(site, source, note);
}
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	const user = { ...await api(site, 'admin/accounts/create', { username: `rx_${label.slice(0, 3)}_${suffix}`, password }, site.accounts.admin.token), password };
	if (!roles.has(site)) {
		const role = await api(site, 'admin/roles/create', { name: `Reaction fixture ${suffix}`, description: '', color: null, iconUrl: null, target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } } }, site.accounts.admin.token);
		roles.set(site, role.id);
	}
	await api(site, 'admin/roles/assign', { roleId: roles.get(site), userId: user.id }, site.accounts.admin.token);
	return user;
}
const show = async (site, note, user) => (await api(site, 'notes/extended-reactions/show', { noteIds: [note.id] }, user?.token))[0];
const react = (site, note, user, reaction) => api(site, 'notes/extended-reactions/create', { noteId: note.id, reaction }, user.token);
const unreact = (site, note, user, reaction) => api(site, 'notes/extended-reactions/delete', { noteId: note.id, reaction }, user.token);
const list = (site, note, user, args = {}) => api(site, 'notes/extended-reactions/list', { noteId: note.id, ...args }, user.token);
async function emoji(site, name) {
	const form = new FormData(); form.set('i', site.accounts.admin.token);
	form.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNw2BL1nxLMMGrA/9EwiBoNgy3DIgwAwJVNH4qw1v8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'reaction.png');
	const result = await fetch(site.origin + '/api/drive/files/create', { method: 'POST', body: form });
	assert.equal(result.status, 200);
	await api(site, 'admin/emoji/add', { fileId: (await result.json()).id, name }, site.accounts.admin.token);
}
try {
	const grid = await account(g, 'g'); const resonite = await account(r, 'r'); const outside = await account(e, 'e');
	for (const [source, destination, author, reader] of [[r, g, resonite, grid], [g, r, grid, resonite]]) {
		const recipient = await api(source, 'users/show', { username: reader.username, host: new URL(destination.origin).host }, author.token);
		const uninvited = await account(destination, `no${source.role}`);
		const sourceFollower = await account(source, `f${source.role}`);
		await api(source, 'following/create', { userId: author.id }, sourceFollower.token);
		const remote = await api(destination, 'users/show', { username: author.username, host: new URL(source.origin).host }, reader.token);
		await api(destination, 'following/create', { userId: remote.id }, reader.token);
		await eventually('follow accepted', async () => (await api(destination, 'users/show', { userId: remote.id }, reader.token)).isFollowing);
		const externalAuthor = await api(e, 'users/show', { username: author.username, host: new URL(source.origin).host }, outside.token);
		await api(e, 'following/create', { userId: externalAuthor.id }, outside.token);
		await eventually('external follow accepted', async () => (await api(e, 'users/show', { userId: externalAuthor.id }, outside.token)).isFollowing);
		for (const args of [{}, { visibility: 'home' }, { localOnly: true }, { visibility: 'followers' }, { visibility: 'specified', visibleUserIds: [recipient.id] }]) {
			const note = await post(source, author, args); const copy = await delivered(destination, source, note);
			assert.equal((await api(destination, 'notes/show', { noteId: copy.id }, reader.token)).gridspaceReactions, true);
			if (['followers', 'specified'].includes(args.visibility)) {
				assert.equal((await api(destination, 'notes/show', { noteId: copy.id }, reader.token)).gridspaceShared, false);
				assert.equal(await show(source, note), undefined); assert.equal(await show(destination, copy), undefined);
				assert.equal(await show(destination, copy, uninvited), undefined);
				await assert.rejects(react(destination, copy, uninvited, '😆'), error => error.code === 'NO_SUCH_NOTE');
			}
			await react(source, note, author, '👍'); await react(source, note, author, '🎉');
			await react(destination, copy, reader, '👍'); await react(destination, copy, reader, '😆');
			const expected = { '👍': 2, '🎉': 1, '😆': 1 };
			if (args.visibility === 'followers') assert.deepEqual((await show(source, note, sourceFollower)).reactions, expected);
			for (const [site, id, user] of [[source, note, author], [destination, copy, reader]]) {
				const state = await show(site, id, user);
				assert.equal(state.shared, true); assert.equal(state.complete, true); assert.deepEqual(state.reactions, expected);
				assert.equal(state.myReactions.length, 2);
				const all = []; let cursor;
				for (let page = 0; page < 5; page++) {
					const rows = await list(site, id, user, { limit: 1, untilId: cursor });
					if (!rows.length) break;
					all.push(...rows); cursor = rows.at(-1).id;
				}
				assert.equal(all.length, 4); assert.equal(new Set(all.map(row => row.id)).size, 4);
				assert.equal((await list(site, id, user, { type: '👍' })).length, 2);
				assert.equal((await show(site, id, user)).revision, state.revision);
			}
			await unreact(destination, copy, reader, '👍');
			assert.deepEqual((await show(source, note, author)).reactions, { '👍': 1, '🎉': 1, '😆': 1 });
			assert.deepEqual((await show(destination, copy, reader)).myReactions, ['😆']);
			await unreact(source, note, author, '🎉');
			assert.deepEqual((await show(destination, copy, reader)).reactions, { '👍': 1, '😆': 1 });
			await react(destination, copy, reader, '🎉');
			if (!args.localOnly && args.visibility !== 'specified') {
				const ext = await delivered(e, source, note);
				await eventually('external primary reaction', async () => (await api(e, 'notes/show', { noteId: ext.id }, outside.token)).reactions['👍'] === 1);
				const externalState = await api(e, 'notes/show', { noteId: ext.id }, outside.token);
				assert.equal(externalState.reactions['😆'] ?? 0, 0); assert.equal(externalState.reactions['🎉'] ?? 0, 0);
			} else assert.equal(await find(e, source, note), undefined);
			fixtures.push({ source: source.role, note, copy });
		}
	}
	console.log('Both directions: public/home/local-only/followers/specified counts, own sets, reactors, pagination, authorization, primary/extra deletion and ordinary external AP PASS');
	const local = await post(r, resonite); const copy = await delivered(g, r, local);
	const name = `rx_${suffix}`; await emoji(g, name); await emoji(r, name);
	await react(r, local, resonite, `:${name}:`); await react(g, copy, grid, '👍'); await react(g, copy, grid, `:${name}:`);
	for (const [site, note, user, other] of [[g, copy, grid, r], [r, local, resonite, g]]) {
		const state = await show(site, note, user); const remoteKey = `${name}@${new URL(other.origin).host}`;
		assert.equal(state.reactions[`:${name}@.:`], 1); assert.equal(state.reactions[`:${remoteKey}:`], 1);
		assert.ok(state.reactionEmojis[remoteKey]?.startsWith('https://'));
		assert.equal((await list(site, note, user, { type: `:${remoteKey}:` })).length, 1);
	}
	const policy = await post(r, resonite, { reactionAcceptance: 'likeOnlyForRemote' }); const policyCopy = await delivered(g, r, policy);
	await react(g, policyCopy, grid, '🎉'); assert.deepEqual((await show(g, policyCopy, grid)).myReactions, ['❤']);
	await assert.rejects(list(g, copy, grid, { untilId: `gr1${'ff'.repeat(40)}` }), error => error.code === 'INVALID_CURSOR');
	console.log('Same-name custom emoji from both origins, peer image URLs, source remote policy and invalid cursor PASS');
	const legacy = await post(r, resonite); const legacyCopy = await delivered(g, r, legacy);
	await react(r, legacy, resonite, '👍');
	await r.db.query('UPDATE note_reaction SET reaction=\'like\' WHERE "noteId"=$1 AND "userId"=$2', [legacy.id, resonite.id]);
	assert.deepEqual((await show(g, legacyCopy, grid)).reactions, { '👍': 1 });
	assert.equal((await list(g, legacyCopy, grid, { type: '👍' }))[0].type, '👍');
	console.log('Legacy reaction names retain normalized counts and filtered actor lists PASS');
	const stranger = await account(g, 'stranger');
	const original = await api(r, 'admin/meta', {}, r.accounts.admin.token);
	try {
		await api(r, 'admin/update-meta', { ugcVisibilityForVisitor: 'none' }, r.accounts.admin.token);
		assert.equal((await show(g, copy, stranger)).complete, true);
		assert.ok((await list(g, copy, stranger)).length > 0);
		await react(g, copy, stranger, '🎉');
	} finally { await api(r, 'admin/update-meta', { ugcVisibilityForVisitor: original.ugcVisibilityForVisitor }, r.accounts.admin.token); }
	const remoteGrid = await api(r, 'users/show', { username: grid.username, host: new URL(g.origin).host }, resonite.token);
	await api(r, 'blocking/create', { userId: remoteGrid.id }, resonite.token);
	assert.equal(await show(g, copy, grid), undefined);
	assert.deepEqual(await list(g, copy, grid), []);
	await assert.rejects(react(g, copy, grid, '😆'), error => error.code === 'NO_SUCH_NOTE');
	await api(r, 'blocking/delete', { userId: remoteGrid.id }, resonite.token);
	const externalNote = await post(e, outside); const externalCopy = (await api(g, 'ap/show', { uri: `${e.origin}/notes/${externalNote.id}` }, grid.token)).object;
	assert.equal((await show(g, externalCopy, grid)).shared, false);
	await assert.rejects(react(g, externalCopy, grid, '🎉'), error => error.code === 'LOCAL_ONLY');
	console.log('Authenticated uncached viewer, source block and non-peer extension rejection PASS');
	savePrivateJson(resolve('.config/gridspace-reactions-test-accounts.json'), { grid, resonite, outside, fixtures, custom: { local, copy, name } });
} finally {
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.accounts.admin.token).catch(() => {});
	await Promise.all([g, r, e].map(site => site.db.end()));
}
