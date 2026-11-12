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

const require = createRequire(resolve('packages/backend/package.json'));
globalThis.fetch = require('node-fetch').default;
const { Client } = require('pg');
const g = loadSite('.', 0);
const r = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
const suffix = randomBytes(5).toString('hex');
const failures = [];
const uri = (site, note) => `${site.origin}/notes/${note.id}`;
async function check(label, run) {
	try { await run(); console.log(`PASS ${label}`); } catch (error) {
		failures.push(label); console.error(`FAIL ${label}: ${error.code ?? error.name}: ${error.message}`);
	}
}
async function account(site, label) {
	return api(site, 'admin/accounts/create', { username: `pv_${label}_${suffix}`, password: randomBytes(24).toString('base64url') }, site.admin.token);
}
async function peerCall(from, path, payload) {
	const body = Buffer.from(JSON.stringify(payload));
	const response = await fetch(from.peer.peerOrigin + path, { method: 'POST', body,
		headers: createGridspaceHeaders(from.peer, 'POST', path, body), signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 200);
	return response.json();
}
async function oldNote(site, template, visibility) {
	const date = Date.now() - 86400000;
	assert.equal(site.config.id, 'aidx');
	const id = (date - 946684800000).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
	await site.db.query('INSERT INTO note SELECT (jsonb_populate_record(NULL::note, to_jsonb(n) || $1::jsonb)).* FROM note n WHERE n.id=$2',
		[JSON.stringify({ id, visibility, gridspaceShared: false }), template.id]);
	return { id, date };
}
try {
	for (const site of [g, r]) {
		site.admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
		const env = Object.fromEntries(readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').trim().split(/\r?\n/).map(line => {
			const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
		}));
		site.peer = resolveGridspaceConfig(site.config.gridspace, site.origin, env);
		site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, database: site.config.db.db, password: env.GRIDSPACE_LAB_DB_PASSWORD });
		await site.db.connect();
		site.meta = await api(site, 'admin/meta', {}, site.admin.token);
		await api(site, 'admin/update-meta', { ugcVisibilityForVisitor: 'all', enableFanoutTimeline: true }, site.admin.token);
		site.author = await account(site, site.role.toLowerCase());
		site.viewer = await account(site, `${site.role.toLowerCase()}v`);
	}
	const start = await api(g, 'gridspace/link', { action: 'start' }, g.author.token);
	const html = await (await fetch(start.authorizationUrl)).text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)[1];
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction, login_token: r.author.token }) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: start.clientKey }, g.author.token);
	for (const [site, peer] of [[g, r], [r, g]]) {
		const link = (await site.db.query('SELECT * FROM gridspace_link WHERE "localUserId"=$1 AND state=\'active\'', [site.author.id])).rows[0];
		const historyInput = { userId: site.author.id, counterpartId: peer.author.id, linkId: link.id, generation: link.generation,
			withReplies: true, withRenotes: true, withFiles: false, limit: 20 };
		const read = id => peerCall(peer, '/gridspace/v1/notes/read', { noteId: id });
		const history = authenticated => peerCall(peer, '/gridspace/v1/history', { ...historyInput, ...(authenticated ? { viewerId: peer.viewer.id } : {}) });
		const template = (await api(site, 'notes/create', { text: `privacy ${suffix}`, localOnly: true }, site.author.token)).createdNote;
		await eventually('template delivered', async () => (await peer.db.query('SELECT 1 FROM note WHERE uri=$1', [uri(site, template)])).rowCount === 1);
		const expectedPolicy = { requireSigninToViewContents: false, makeNotesHiddenBefore: null, makeNotesFollowersOnlyBefore: null };
		const policy = async patch => {
			Object.assign(expectedPolicy, patch);
			await api(site, 'i/update', patch, site.author.token);
			await eventually('all peer policy fields match source', async () => {
				const row = (await peer.db.query('SELECT "requireSigninToViewContents", "makeNotesHiddenBefore", "makeNotesFollowersOnlyBefore" FROM "user" WHERE uri=$1', [`${site.origin}/users/${site.author.id}`])).rows[0];
				return row && Object.entries(expectedPolicy).every(([key, value]) => row[key] === value);
			});
		};
		const old = await oldNote(site, template, 'public');
		const home = await oldNote(site, template, 'home');
		for (const field of ['makeNotesHiddenBefore', 'makeNotesFollowersOnlyBefore']) {
			for (const threshold of [Math.floor(Date.now() / 1000) - 3600, -3600]) {
				await policy({ [field]: threshold });
				await check(`${site.role} ${field} ${threshold > 0 ? 'absolute' : 'relative'} source history`, async () => {
					for (const authenticated of [false, true]) {
						const page = await history(authenticated);
						assert.equal(page.active, true);
						assert.ok(page.items.some(n => n.id === template.id), 'new public note must survive cutoff');
						assert.ok(page.items.every(n => n.id !== old.id && n.id !== home.id));
					}
				});
				await check(`${site.role} ${field} raw body refused without deletion`, async () => {
					assert.equal((await read(template.id)).notes.length, 1, 'new body must remain available');
					for (const note of [old, home]) {
						const bundle = await read(note.id);
						assert.equal(bundle.deleted, false); assert.equal(bundle.unavailable, true); assert.deepEqual(bundle.notes, []);
						await peerCall(site, '/gridspace/v1/notes/sync', { noteId: note.id });
						assert.equal((await peer.db.query('SELECT 1 FROM note WHERE uri=$1', [uri(site, note)])).rowCount, 0);
						assert.equal((await peer.db.query('SELECT 1 FROM gridspace_note_tombstone WHERE uri=$1', [uri(site, note)])).rowCount, 0);
					}
				});
			}
			await check(`${site.role} ${field} non-hiding cutoff and recovery`, async () => {
				for (const threshold of [Math.floor(old.date / 1000) - 3600, -172800, null]) {
					await policy({ [field]: threshold });
					for (const authenticated of [false, true]) {
						const page = await history(authenticated);
						assert.equal(page.active, true);
						for (const note of [old, home, template]) assert.ok(page.items.some(n => n.id === note.id));
					}
					for (const note of [old, home]) assert.equal((await read(note.id)).notes.length, 1);
				}
			});
		}
		await check(`${site.role} reply import does not fetch hidden parent`, async () => {
			await policy({ makeNotesHiddenBefore: -3600 });
			try {
				const reply = (await api(site, 'notes/create', { text: `reply ${suffix}`, localOnly: true, replyId: home.id }, site.author.token)).createdNote;
				await peerCall(site, '/gridspace/v1/notes/sync', { noteId: reply.id });
				assert.equal((await peer.db.query('SELECT 1 FROM note WHERE uri=$1', [uri(site, home)])).rowCount, 0);
				const imported = (await peer.db.query('SELECT "replyId" FROM note WHERE uri=$1', [uri(site, reply)])).rows[0];
				assert.ok(imported); assert.equal(imported.replyId, null);
			} finally { await policy({ makeNotesHiddenBefore: null }); }
		});
		await check(`${site.role} suspended is unavailable, recovery imports, deletion tombstones`, async () => {
			await peerCall(site, '/gridspace/v1/notes/sync', { noteId: old.id });
			const cachedId = (await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, old)])).rows[0].id;
			await site.db.query('UPDATE "user" SET "isSuspended"=true WHERE id=$1', [site.author.id]);
			try {
				assert.deepEqual(await read(old.id), { deleted: false, unavailable: true, notes: [] });
				await peerCall(site, '/gridspace/v1/notes/sync', { noteId: old.id });
				assert.equal((await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, old)])).rows[0]?.id, cachedId);
				assert.equal((await peer.db.query('SELECT 1 FROM gridspace_note_tombstone WHERE uri=$1', [uri(site, old)])).rowCount, 0);
			} finally { await site.db.query('UPDATE "user" SET "isSuspended"=false WHERE id=$1', [site.author.id]); }
			await peerCall(site, '/gridspace/v1/notes/sync', { noteId: old.id });
			assert.equal((await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, old)])).rows[0]?.id, cachedId);
			await api(site, 'notes/delete', { noteId: old.id }, site.author.token);
			await peerCall(site, '/gridspace/v1/notes/sync', { noteId: old.id });
			assert.equal((await peer.db.query('SELECT 1 FROM gridspace_note_tombstone WHERE uri=$1', [uri(site, old)])).rowCount, 1);
			assert.equal((await peer.db.query('SELECT 1 FROM note WHERE uri=$1', [uri(site, old)])).rowCount, 0);
		});
		await policy({ requireSigninToViewContents: true });
		await check(`${site.role} anonymous history excludes login-required, signed-in history retains it`, async () => {
			assert.equal((await history(false)).items.length, 0);
			assert.ok((await history(true)).items.some(n => n.id === home.id));
			assert.equal((await read(home.id)).notes.length, 1);
		});
		await check(`${site.role} policy update reaches peer without followers`, async () => {
			assert.equal((await site.db.query('SELECT count(*)::int AS n FROM following WHERE "followeeId"=$1 AND "followerHost"=$2', [site.author.id, new URL(peer.origin).host])).rows[0].n, 0);
			await eventually('remote privacy updated', async () => (await peer.db.query('SELECT "requireSigninToViewContents" AS required FROM "user" WHERE uri=$1', [`${site.origin}/users/${site.author.id}`])).rows[0]?.required === true);
			const copy = (await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, template)])).rows[0];
			await assert.rejects(api(peer, 'notes/show', { noteId: copy.id }), error => error.code === 'CONTENT_RESTRICTED_BY_USER');
			assert.equal((await api(peer, 'notes/show', { noteId: copy.id }, peer.viewer.token)).text, template.text);
		});
		await policy({ requireSigninToViewContents: false });
		await check(`${site.role} cached hidden policy applies and clears without followers`, async () => {
			await peerCall(site, '/gridspace/v1/notes/sync', { noteId: home.id });
			const copy = (await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, home)])).rows[0];
			await policy({ makeNotesHiddenBefore: -3600 });
			{
				const hidden = await api(peer, 'notes/show', { noteId: copy.id }, peer.viewer.token);
				assert.equal(hidden.isHidden, true);
				assert.equal(hidden.text, null, 'hidden flag must not leave the original body readable');
			}
			await policy({ makeNotesHiddenBefore: null });
			assert.equal((await api(peer, 'notes/show', { noteId: copy.id }, peer.viewer.token)).text, template.text);
			await policy({ makeNotesFollowersOnlyBefore: -3600 });
			{
				const hidden = await api(peer, 'notes/show', { noteId: copy.id }, peer.viewer.token);
				assert.equal(hidden.isHidden, true);
				assert.equal(hidden.text, null, 'hidden flag must not leave the original body readable');
			}
			await policy({ makeNotesFollowersOnlyBefore: null });
			assert.equal((await api(peer, 'notes/show', { noteId: copy.id }, peer.viewer.token)).text, template.text);
		});
		await check(`${site.role} LTL positive/negative controls in DB, fallback and Redis paths`, async () => {
			const copy = (await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, template)])).rows[0];
			const control = (await api(peer, 'notes/create', { text: `local control ${suffix}`, localOnly: true }, peer.viewer.token)).createdNote;
			const sinceId = (parseInt(copy.id.slice(0, 8), 36) - 1).toString(36).padStart(8, '0') + '00000000';
			for (const mode of ['db', 'fallback', 'redis']) {
				const params = { limit: 100, ...(mode === 'redis' ? {} : { sinceId }) };
				for (const visibility of ['all', 'local']) {
					await api(peer, 'admin/update-meta', { ugcVisibilityForVisitor: visibility, enableFanoutTimeline: mode !== 'db', enableFanoutTimelineDbFallback: mode !== 'redis' }, peer.admin.token);
					await eventually('local control reaches selected LTL path', async () => (await api(peer, 'notes/local-timeline', params)).some(n => n.id === control.id));
					const notes = await api(peer, 'notes/local-timeline', params);
					assert.ok(notes.some(n => n.id === control.id));
					assert.equal(notes.some(n => n.id === copy.id), visibility === 'all', `${mode}/${visibility}`);
					if (visibility === 'local') assert.ok(notes.every(n => n.user.host == null));
					assert.ok((await api(peer, 'notes/local-timeline', params, peer.viewer.token)).some(n => n.id === copy.id));
				}
			}
		});
		await api(peer, 'admin/update-meta', { ugcVisibilityForVisitor: 'all' }, peer.admin.token);
		await check(`${site.role} cached dynamic followers-only stays in authorized profile history`, async () => {
			const remote = (await peer.db.query('SELECT id FROM "user" WHERE uri=$1', [`${site.origin}/users/${site.author.id}`])).rows[0];
			await api(peer, 'following/create', { userId: remote.id }, peer.viewer.token);
			await eventually('ordinary follow accepted', async () => (await api(peer, 'users/show', { userId: remote.id }, peer.viewer.token)).isFollowing);
			const threshold = Math.floor(Date.now() / 1000) + 60;
			await policy({ makeNotesFollowersOnlyBefore: threshold });
			await eventually('dynamic restriction propagated', async () => (await peer.db.query('SELECT "makeNotesFollowersOnlyBefore" AS threshold FROM "user" WHERE id=$1', [remote.id])).rows[0].threshold === threshold);
			const allowed = await api(peer, 'gridspace/history', { userId: peer.author.id, limit: 20 }, peer.viewer.token);
			assert.ok(allowed.notes.some(n => n.uri === uri(site, template) && n.text === template.text && n.visibility === 'followers'));
			const localControl = (await api(peer, 'notes/create', { text: `profile control ${suffix}`, localOnly: true }, peer.author.token)).createdNote;
			for (const token of [undefined, peer.admin.token]) {
				const denied = await api(peer, 'gridspace/history', { userId: peer.author.id, limit: 20 }, token);
				assert.ok(denied.notes.some(n => n.id === localControl.id));
				assert.ok(denied.notes.every(n => n.uri !== uri(site, template)));
			}
			await policy({ makeNotesFollowersOnlyBefore: null });
		});
		await check(`${site.role} first actor resolution preserves all visibility fields`, async () => {
			const author = await account(site, `${site.role.toLowerCase()}i`);
			// Set the fixture before any outgoing Update or note can resolve this actor at its peer.
			await site.db.query('UPDATE "user" SET "requireSigninToViewContents"=true, "makeNotesHiddenBefore"=100, "makeNotesFollowersOnlyBefore"=-86400 WHERE id=$1', [author.id]);
			const note = (await api(site, 'notes/create', { text: `initial ${suffix}`, localOnly: true }, author.token)).createdNote;
			await peerCall(site, '/gridspace/v1/notes/sync', { noteId: note.id });
			const imported = (await peer.db.query('SELECT "requireSigninToViewContents", "makeNotesHiddenBefore", "makeNotesFollowersOnlyBefore" FROM "user" WHERE uri=$1', [`${site.origin}/users/${author.id}`])).rows[0];
			assert.deepEqual(imported, { requireSigninToViewContents: true, makeNotesHiddenBefore: 100, makeNotesFollowersOnlyBefore: -86400 });
			const copy = (await peer.db.query('SELECT id FROM note WHERE uri=$1', [uri(site, note)])).rows[0];
			await assert.rejects(api(peer, 'notes/show', { noteId: copy.id }), error => error.code === 'CONTENT_RESTRICTED_BY_USER');
			assert.equal((await api(peer, 'notes/show', { noteId: copy.id }, peer.viewer.token)).text, note.text);
		});
	}
} finally {
	for (const site of [g, r]) {
		if (site.meta) await api(site, 'admin/update-meta', Object.fromEntries(['ugcVisibilityForVisitor', 'enableFanoutTimeline', 'enableFanoutTimelineDbFallback'].map(key => [key, site.meta[key]])), site.admin.token);
		if (site.db) await site.db.end();
	}
}
assert.deepEqual(failures, [], 'public visibility regression checks');
