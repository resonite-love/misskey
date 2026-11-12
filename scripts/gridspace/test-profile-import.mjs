/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite, eventually, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
export async function makeProfileAccount(site) {
	const admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
	const user = await api(site, 'admin/accounts/create', { username: `profile_${randomBytes(5).toString('hex')}`, password: randomBytes(24).toString('base64url') }, admin.token);
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	return { ...await api(site, 'i', {}, user.token), token: user.token };
}
export async function seedProfile(site, user) {
	const upload = new FormData(); upload.set('i', user.token);
	upload.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'profile.png');
	const response = await fetch(`${site.origin}/api/drive/files/create`, { method: 'POST', body: upload }); assert.equal(response.status, 200);
	const file = await response.json();
	const profile = { name: '移行元の名前', description: '**自己紹介**\n:resonite:', location: 'Tokyo', birthday: '2000-01-02', fields: [{ name: 'Long field', value: 'a'.repeat(5000) }], avatarId: file.id, bannerId: file.id };
	await api(site, 'i/update', profile, user.token);
	return profile;
}
async function consent(grid, old) {
	const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
	const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
	const response = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
	assert.equal(response.status, 302); const callback = new URL(response.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
}
// Helpers can also be used by the browser fixture without running this API suite.
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/gridspace/test-profile-import.mjs')) {
	const grid = await makeProfileAccount(g); const old = await makeProfileAccount(r);
	const original = await seedProfile(r, old); await consent(grid, old);
	const password = readFileSync(resolve(g.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	const db = new Client({ host: g.config.db.host, port: g.config.db.port, user: g.config.db.user, password, database: g.config.db.db }); await db.connect();
	try {
		const key = `gridspace-profile:${grid.id}`;
		await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
		let editsDone = false; let importDone = false;
		const editing = api(g, 'i/update', { name: 'Keep my new name' }, grid.token).then(result => { editsDone = true; return result; });
		const waiters = async () => Number((await db.query("SELECT count(*) count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count);
		await eventually('normal edit waits for profile lock', async () => await waiters() >= 1);
		const importing = api(g, 'gridspace/profile-import', {}, grid.token).then(result => { importDone = true; return result; });
		await eventually('import waits behind the edit', async () => await waiters() >= 2);
		assert.equal(editsDone, false); assert.equal(importDone, false);
		await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
		await editing; const result = await importing;
		assert.equal(result.complete, true); assert.deepEqual(result.skipped, ['name']); assert.equal(result.copied.length, 6);
	} finally { await db.end(); }
	const copied = await api(g, 'i', {}, grid.token);
	assert.equal(copied.name, 'Keep my new name');
	for (const field of ['description', 'location', 'birthday', 'fields']) assert.deepEqual(copied[field], original[field]);
	for (const field of ['avatarId', 'bannerId']) { assert.ok(copied[field]); assert.notEqual(copied[field], original[field]); assert.equal((await api(g, 'drive/files/show', { fileId: copied[field] }, grid.token)).userId, grid.id); }
	console.log('Shared profile lock preserves concurrent normal edit; bio, long fields and owned images copy PASS');
	await api(g, 'i/update', { description: null }, grid.token);
	await api(g, 'gridspace/profile-import', {}, grid.token);
	assert.equal((await api(g, 'i', {}, grid.token)).description, null);
	assert.equal((await api(r, 'i', {}, old.token)).description, original.description);
	console.log('Retry does not overwrite or restore already imported fields; source profile unchanged PASS');
	await assert.rejects(api(r, 'gridspace/profile-import', {}, old.token), error => error.code === 'GRIDSPACE_PROFILE_UNAVAILABLE');
	await api(g, 'gridspace/link', { action: 'revoke' }, grid.token);
	await assert.rejects(api(g, 'gridspace/profile-import', {}, grid.token), error => error.code === 'GRIDSPACE_PROFILE_UNAVAILABLE');
	console.log('Reverse direction and revoked link rejected PASS');
	savePrivateJson(resolve('.config/gridspace-profile-test-accounts.json'), { grid, old });
}
