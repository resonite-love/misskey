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
const suffix = randomBytes(5).toString('hex');
const query = `Search ${suffix}`;
for (const site of [g, r, e]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
const uri = (site, note) => note.uri ?? `${site.origin}/notes/${note.id}`;
const post = async (site, user, args = {}) => (await api(site, 'notes/create', { text: query, localOnly: true, ...args }, user.token)).createdNote;
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	return { ...await api(site, 'admin/accounts/create', { username: `s_${label}_${suffix}`, password }, site.accounts.admin.token), password };
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
async function historical(site, template, date, patch = {}) {
	assert.equal(site.config.id, 'aidx');
	const id = (date - 946684800000).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
	const row = { id, gridspaceShared: false, text: query, ...patch };
	await site.db.query('INSERT INTO note SELECT (jsonb_populate_record(NULL::note, to_jsonb(n) || $1::jsonb)).* FROM note n WHERE n.id=$2', [JSON.stringify(row), template.id]);
	return { ...template, ...row };
}
async function activityPubStatus(url) {
	// The public test tunnel may reset an HTTP/2 stream. Only retry this read-only probe.
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(url, { headers: { accept: 'application/activity+json' }, signal: AbortSignal.timeout(10000) });
			await response.body?.cancel();
			return response.status;
		} catch (error) {
			if (attempt >= 2) throw error;
			await new Promise(resolveWait => setTimeout(resolveWait, 500));
		}
	}
}
async function collect(site, token, params = {}, initial, between) {
	let page = initial;
	const notes = []; const users = [];
	for (let i = 0; i < 40; i++) {
		page ??= await api(site, 'gridspace/search', { query, limit: 20, ...params }, token);
		assert.equal(page.peerAvailable, true);
		notes.push(...page.notes); users.push(...page.users);
		if (!page.cursor) return { notes, users };
		if (between) { await between(); between = null; }
		page = await api(site, 'gridspace/search', { query, limit: 20, ...params, cursor: page.cursor }, token);
	}
	throw new Error('Search did not terminate');
}
const oldMeta = new Map();
const fixtureRoles = new Map();
try {
	for (const site of [g, r]) {
		const meta = await api(site, 'admin/meta', {}, site.accounts.admin.token);
		oldMeta.set(site, meta.ugcVisibilityForVisitor);
		// Keep search enabled on the dedicated lab so people can exercise the deployed UI.
		await api(site, 'admin/roles/update-default-policies', { policies: { ...meta.policies, canSearchNotes: true } }, site.accounts.admin.token);
		await api(site, 'admin/update-meta', { ugcVisibilityForVisitor: 'all' }, site.accounts.admin.token);
	}
	const gu = await account(g, 'g'); const ru = await account(r, 'r'); const viewer = await account(g, 'v');
	savePrivateJson(resolve('.config/gridspace-search-test-accounts.json'), { grid: gu, resonite: ru, viewer, query });
	for (const [site, users] of [[g, [gu, viewer]], [r, [ru]]]) {
		const role = await api(site, 'admin/roles/create', {
			name: `Search fixture ${suffix}`, description: 'Temporary API fixture role', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } },
		}, site.accounts.admin.token);
		fixtureRoles.set(site, role.id);
		for (const user of users) await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, site.accounts.admin.token);
	}
	await link(gu, ru);
	const remote = await api(g, 'users/show', { username: ru.username, host: new URL(r.origin).host }, viewer.token);
	const gt = await post(g, gu, { visibility: 'specified', visibleUserIds: [gu.id] });
	const rt = await post(r, ru, { visibility: 'specified', visibleUserIds: [ru.id] });
	const start = Date.now() - 86400000;
	const old = [];
	for (let n = 0; n < 12; n++) {
		const site = n % 2 ? r : g;
		const note = await historical(site, site === g ? gt : rt, start + n * 1000, { visibility: n % 3 ? 'public' : 'home', visibleUserIds: [], text: n === 5 ? 'CW only body' : query, cw: n === 5 ? query : null });
		old.push({ site, note });
	}
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, old[1].note)])).rowCount, 0);
	const hidden = await historical(r, rt, start - 1000, { visibility: 'followers' });
	const localPrivate = await historical(g, gt, start - 2000, { visibility: 'specified', visibleUserIds: [viewer.id] });
	const secretQuery = `specified_secret_${suffix}`;
	const hiddenMention = await post(g, gu, { visibility: 'specified', visibleUserIds: [gu.id], text: `${query} ${secretQuery} @${viewer.username}` });
	const noMatch = await api(g, 'gridspace/search', { query: secretQuery, limit: 1 }, viewer.token);
	assert.deepEqual(noMatch.notes, []); assert.equal(noMatch.cursor, null);
	const collision = old[2].note.id;
	await r.db.query('UPDATE note SET id=$1 WHERE id=$2', [collision, old[3].note.id]); old[3].note.id = collision;
	const first = await api(g, 'gridspace/search', { query, limit: 3 }, viewer.token);
	assert.equal(first.notes.length, 3);
	let fresh;
	const result = await collect(g, viewer.token, {}, first, async () => { fresh = await post(r, ru); });
	assert.equal(result.notes.length, 13);
	assert.ok(!result.notes.some(note => note.id === hiddenMention.id));
	assert.equal(new Set(result.notes.map(note => uri(g, note))).size, 13);
	assert.ok(old.every(item => result.notes.some(note => uri(g, note) === uri(item.site, item.note))));
	assert.ok(result.notes.some(note => note.id === localPrivate.id && note.text === query && !note.isHidden));
	assert.ok(result.notes.some(note => note.cw === query && note.text === 'CW only body'));
	assert.ok(!result.notes.some(note => note.uri === uri(r, hidden) || note.uri === uri(r, fresh)));
	assert.ok(result.notes.every((note, n) => n === 0 || new Date(result.notes[n - 1].createdAt) >= new Date(note.createdAt)));
	assert.ok(result.notes.filter(note => note.user.host != null).every(note => note.localOnly && note.text != null));
	console.log('Uncached history, local-only/home/CW, private visibility, ID collision and snapshot pagination PASS');
	const filtered = (await collect(g, viewer.token, { userId: gu.id, rangeStartAt: start, rangeEndAt: start + 6000 })).notes;
	assert.equal(filtered.length, 7);
	assert.ok(filtered.some(note => note.userId === gu.id) && filtered.some(note => note.userId === remote.id));
	const peerSelected = (await collect(g, viewer.token, { userId: remote.id, rangeStartAt: start, rangeEndAt: start + 6000 })).notes;
	assert.deepEqual(peerSelected.map(note => uri(g, note)), filtered.map(note => uri(g, note)));
	for (const change of [{ query: 'different' }, { userId: gu.id }, { rangeEndAt: start }, { kind: 'users' }]) {
		await assert.rejects(api(g, 'gridspace/search', { query, cursor: first.cursor, ...change }, viewer.token), err => err.code === 'GRIDSPACE_SEARCH_UNAVAILABLE');
	}
	await assert.rejects(api(g, 'gridspace/search', { query, cursor: first.cursor }, gu.token), err => err.code === 'GRIDSPACE_SEARCH_UNAVAILABLE');
	const reverse = (await collect(r, ru.token, { rangeEndAt: start + 20000 })).notes;
	assert.ok(old.every(item => reverse.some(note => uri(r, note) === uri(item.site, item.note))));
	assert.ok(!reverse.some(note => note.uri === uri(g, localPrivate)));
	console.log('Linked-author expansion, date range, reverse search and cursor binding PASS');
	const stranger = await account(r, 'new');
	await api(r, 'i/update', { name: `New ${suffix}` }, stranger.token);
	assert.equal((await g.db.query('SELECT id FROM "user" WHERE uri=$1', [`${r.origin}/users/${stranger.id}`])).rowCount, 0);
	const people = (await collect(g, viewer.token, { kind: 'users', query: stranger.username })).users;
	assert.equal(people.length, 1); assert.equal(people[0].user.username, stranger.username); assert.equal(people[0].linkedAccounts.length, 0);
	for (const name of [gu.username, ru.username]) {
		const found = (await collect(g, viewer.token, { kind: 'users', query: name })).users;
		assert.equal(found.length, 1);
		assert.equal(found[0].linkedAccounts.length, 1);
		assert.deepEqual(new Set([found[0].user.username, found[0].linkedAccounts[0].username]), new Set([gu.username, ru.username]));
	}
	await api(g, 'i/update', { name: `Same ${suffix}` }, gu.token);
	await api(r, 'i/update', { name: `Same ${suffix}` }, stranger.token);
	const sameNames = (await collect(g, viewer.token, { kind: 'users', query: `Same ${suffix}` })).users;
	assert.equal(sameNames.length, 2);
	assert.equal(sameNames.find(item => item.user.username === stranger.username).linkedAccounts.length, 0);
	console.log('Uncached people, old/new username lookup, verified links and distinct same-name people PASS');
	await api(g, 'mute/create', { userId: remote.id }, viewer.token);
	assert.ok((await collect(g, viewer.token)).notes.every(note => note.userId !== remote.id));
	assert.equal((await collect(g, viewer.token, { kind: 'users', query: ru.username })).users.length, 0);
	await api(g, 'mute/delete', { userId: remote.id }, viewer.token);
	await api(g, 'blocking/create', { userId: remote.id }, viewer.token);
	assert.ok((await collect(g, viewer.token)).notes.every(note => note.userId !== remote.id));
	await api(g, 'blocking/delete', { userId: remote.id }, viewer.token);
	const viewerOnR = await api(r, 'users/show', { username: viewer.username, host: new URL(g.origin).host }, ru.token);
	await api(r, 'blocking/create', { userId: viewerOnR.id }, ru.token);
	assert.ok((await collect(g, viewer.token)).notes.every(note => note.userId !== remote.id));
	assert.equal((await collect(g, viewer.token, { kind: 'users', query: ru.username })).users.length, 0);
	assert.equal((await collect(g, viewer.token, { kind: 'users', query: gu.username })).users[0].linkedAccounts.length, 0);
	await api(r, 'blocking/delete', { userId: viewerOnR.id }, ru.token);
	const deleted = old.find(item => item.site === r).note;
	await api(r, 'notes/delete', { noteId: deleted.id }, ru.token);
	assert.ok(!(await collect(g, viewer.token)).notes.some(note => note.uri === uri(r, deleted)));
	await eventually('deleted search cache removed', async () => (await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, deleted)])).rowCount === 0);
	console.log('Destination mute/block, source block, hidden linked account and deletion PASS');
	const linkedPage = await api(g, 'gridspace/search', { query, userId: gu.id, limit: 3 }, viewer.token);
	await api(r, 'gridspace/link', { action: 'revoke' }, ru.token);
	await assert.rejects(api(g, 'gridspace/search', { query, userId: gu.id, cursor: linkedPage.cursor }, viewer.token), err => err.code === 'GRIDSPACE_SEARCH_UNAVAILABLE');
	await link(gu, ru);
	await assert.rejects(api(g, 'gridspace/search', { query, userId: gu.id, cursor: linkedPage.cursor }, viewer.token), err => err.code === 'GRIDSPACE_SEARCH_UNAVAILABLE');
	const anonymous = (await collect(g, undefined)).notes;
	assert.ok(anonymous.some(note => note.userId === remote.id));
	assert.ok(!anonymous.some(note => note.id === localPrivate.id));
	await api(g, 'admin/update-meta', { ugcVisibilityForVisitor: 'local' }, g.accounts.admin.token);
	assert.ok((await collect(g, undefined)).notes.every(note => note.user.host == null));
	await api(g, 'admin/update-meta', { ugcVisibilityForVisitor: 'all' }, g.accounts.admin.token);
	await api(r, 'admin/update-meta', { ugcVisibilityForVisitor: 'none' }, r.accounts.admin.token);
	assert.ok((await collect(g, undefined)).notes.every(note => note.user.host == null));
	assert.ok((await collect(g, viewer.token)).notes.some(note => note.userId === remote.id));
	await api(r, 'admin/update-meta', { ugcVisibilityForVisitor: 'all' }, r.accounts.admin.token);
	await api(r, 'i/update', { requireSigninToViewContents: true }, ru.token);
	assert.ok((await collect(g, undefined)).notes.every(note => note.userId !== remote.id));
	assert.ok((await collect(g, viewer.token)).notes.some(note => note.userId === remote.id));
	await api(r, 'i/update', { requireSigninToViewContents: false, makeNotesHiddenBefore: 0 }, ru.token);
	assert.ok((await collect(g, viewer.token)).notes.every(note => note.userId !== remote.id));
	const dynamicQuery = `dynamic_secret_${suffix}`;
	const dynamic = await historical(r, rt, start - 4000, { visibility: 'public', visibleUserIds: [], text: dynamicQuery });
	let invisible = await api(g, 'gridspace/search', { query: dynamicQuery, limit: 1 }, viewer.token);
	assert.deepEqual(invisible.notes, []); assert.equal(invisible.cursor, null);
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, dynamic)])).rowCount, 0);
	await api(r, 'i/update', { makeNotesHiddenBefore: null, makeNotesFollowersOnlyBefore: 0 }, ru.token);
	assert.ok((await collect(g, viewer.token)).notes.every(note => note.userId !== remote.id));
	invisible = await api(g, 'gridspace/search', { query: dynamicQuery, limit: 1 }, viewer.token);
	assert.deepEqual(invisible.notes, []); assert.equal(invisible.cursor, null);
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, dynamic)])).rowCount, 0);
	await api(r, 'i/update', { makeNotesFollowersOnlyBefore: null }, ru.token);
	await api(g, 'i/update', { makeNotesHiddenBefore: 0 }, gu.token);
	assert.ok((await collect(g, viewer.token)).notes.every(note => note.userId !== gu.id));
	assert.ok((await collect(g, gu.token)).notes.some(note => note.userId === gu.id));
	await api(g, 'i/update', { makeNotesHiddenBefore: null, makeNotesFollowersOnlyBefore: 0 }, gu.token);
	assert.ok((await collect(g, viewer.token)).notes.filter(note => note.visibility === 'public' || note.visibility === 'home').every(note => note.userId !== gu.id));
	await api(g, 'i/update', { makeNotesFollowersOnlyBefore: null }, gu.token);
	console.log('Signin requirement and dynamic hidden/followers-only cutoffs checked before search results PASS');
	for (const item of old.filter(item => item.site === r)) {
		assert.equal(await activityPubStatus(uri(r, item.note)), 404);
		assert.equal((await e.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, item.note)])).rowCount, 0);
	}
	assert.equal((await g.db.query('SELECT id FROM note WHERE uri=$1', [uri(r, hidden)])).rowCount, 0);
	savePrivateJson(resolve('.config/gridspace-search-test-accounts.json'), { grid: gu, resonite: ru, viewer, query, start });
	console.log('Unlink/relink, both anonymous policies and no external/private leakage PASS');
} finally {
	for (const [site, roleId] of fixtureRoles) await api(site, 'admin/roles/delete', { roleId }, site.accounts.admin.token);
	for (const [site, value] of oldMeta) await api(site, 'admin/update-meta', { ugcVisibilityForVisitor: value }, site.accounts.admin.token);
	for (const site of [g, r, e]) await site.db.end();
}
