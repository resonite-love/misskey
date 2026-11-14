/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { createGridspaceHeaders, resolveGridspaceConfig } from '../../packages/backend/src/core/gridspace/peer-protocol.ts';
const g = loadSite('.', 0), r = loadSite('../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const envFor = site => Object.fromEntries(readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').trim().split(/\r?\n/).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const env = envFor(r);
const db = new Client({ host: r.config.db.host, port: r.config.db.port, user: r.config.db.user, password: env.GRIDSPACE_LAB_DB_PASSWORD, database: r.config.db.db });
async function account(site) {
 const admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
 return api(site, 'admin/accounts/create', { username: 'play317_' + randomBytes(4).toString('hex'), password: randomBytes(20).toString('base64url') }, admin.token);
}
const grid = await account(g), old = await account(r), foreign = await account(r);
const make = (token, title, visibility) => api(r, 'flash/create', { title, summary: 'Copy test', script: 'Ui:render([])', permissions: ['write:notes'], visibility }, token);
const source = [await make(old.token, 'First', 'private'), await make(old.token, 'Second', 'public'), await make(old.token, 'Third', 'private')];
const outside = await make(foreign.token, 'Other owner', 'private');
const start = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
assert.ok(new URL(start.authorizationUrl).searchParams.get('scope').split(' ').includes('read:flash'));
const transaction = (await (await fetch(start.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
const decision = await fetch(r.origin + '/oauth/decision', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) }); assert.equal(decision.status, 302);
const callback = new URL(decision.headers.get('location'));
await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: start.clientKey }, grid.token);
const copy = action => api(g, 'gridspace/play-import', { action }, grid.token);
await db.connect();
try {
 const row = (await db.query(`SELECT l.id, l.generation, t.token, t.permission FROM gridspace_link l JOIN access_token t ON t."userId"=l."localUserId" AND encode(sha256(convert_to(t.token,'UTF8')),'hex')=l."privateTokenHash" WHERE l."localUserId"=$1 AND l.state='active'`, [old.id])).rows[0]; assert.ok(row);
 const peer = resolveGridspaceConfig(g.config.gridspace, g.origin, envFor(g));
 const path = '/gridspace/v1/link/plays';
 const read = async playId => {
  const body = Buffer.from(JSON.stringify({ linkId: row.id, generation: row.generation, localUserId: grid.id, accessToken: row.token, playId }));
  const response = await fetch(r.origin + path, { method: 'POST', body, headers: createGridspaceHeaders(peer, 'POST', path, body) });
  return { status: response.status, data: await response.json() };
 };
 assert.deepEqual(await read(outside.id), { status: 409, data: { error: 'PLAY_UNAVAILABLE' } }, 'Foreign-owned Play must be refused');
 const first = await read(source[0].id); assert.equal(first.status, 200); assert.equal(first.data.play.visibility, 'private');
 await db.query('UPDATE access_token SET permission=array_remove(permission,$1) WHERE token=$2', ['read:flash', row.token]);
 assert.equal((await read(source[0].id)).status, 403, 'Missing scope must be refused');
 await assert.rejects(copy('start'), error => error.code === 'GRIDSPACE_PLAY_IMPORT_UNAVAILABLE');
 await db.query('UPDATE access_token SET permission=$1 WHERE token=$2', [row.permission, row.token]);
 let job = await copy('start'); assert.equal(job.total, 3); assert.equal(job.done, 2); assert.equal(job.pending, 1);
 job = await copy('step'); assert.equal(job.done, 3); assert.equal(job.complete, true);
 let copies = await api(g, 'flash/my', {}, grid.token); assert.equal(copies.length, 3);
 for (const original of source) {
  const copied = copies.find(item => item.title === original.title); assert.ok(copied);
  assert.notEqual(copied.id, original.id); assert.equal(copied.user.id, grid.id); assert.equal(copied.script, original.script); assert.equal(copied.visibility, original.visibility); assert.deepEqual(copied.permissions, original.permissions); assert.equal(copied.likedCount, 0);
 }
 const edited = copies[0], deleted = copies[1];
 await api(g, 'flash/update', { flashId: edited.id, title: 'Local edit' }, grid.token);
 await api(g, 'flash/delete', { flashId: deleted.id }, grid.token);
 await copy('start'); await copy('retry');
 copies = await api(g, 'flash/my', {}, grid.token); assert.equal(copies.length, 2); assert.ok(copies.some(item => item.title === 'Local edit')); assert.ok(!copies.some(item => item.id === deleted.id));
 assert.deepEqual((await api(r, 'flash/my', {}, old.token)).map(item => item.title).sort(), ['First', 'Second', 'Third']);
 console.log('PASS: actual OAuth + PostgreSQL copy, private/public ownership, missing scope and foreign owner denial, bounded batches, idempotent retry, independent edit/delete');
} finally { await db.end(); }
