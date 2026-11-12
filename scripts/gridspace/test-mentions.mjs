/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { api, loadSite, savePrivateJson } from './lab.mjs';
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const suffix = randomBytes(5).toString('hex');
for (const site of [g, r]) site.admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin.token;
const create = (site, role) => api(site, 'admin/accounts/create', { username: `m_${role}_${suffix}`, password: randomBytes(24).toString('base64url') }, site.admin);
const grid = await create(g, 'grid'); const old = await create(r, 'old'); const author = await create(r, 'author'); const other = await create(r, 'other');
const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)[1];
const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
assert.equal(decision.status, 302);
const callback = new URL(decision.headers.get('location'));
await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
assert.equal((await api(g, 'gridspace/private-grant', {}, grid.token)).peerRole, 'source');
const post = async (params) => (await api(r, 'notes/create', params, author.token)).createdNote;
const publicNote = await post({ text: `@${old.username} public mention ${suffix}` });
const home = await post({ text: `@${old.username} home mention ${suffix}`, visibility: 'home', localOnly: true });
const direct = await post({ text: `Direct without textual mention ${suffix}`, cw: 'Private CW', visibility: 'specified', visibleUserIds: [old.id] });
const denied = await post({ text: `@${old.username} not a recipient ${suffix}`, visibility: 'specified', visibleUserIds: [other.id] });
const unrelated = await post({ text: `unrelated ${suffix}` });
const channel = await api(r, 'channels/create', { name: `mentions ${suffix}`, isSensitive: true }, author.token);
const inChannel = await post({ text: `@${old.username} sensitive channel mention ${suffix}`, channelId: channel.id });
const muted = await post({ text: `@${old.username} muted thread ${suffix}` });
await api(r, 'notes/thread-muting/create', { noteId: muted.id }, old.token);
const read = (params) => api(g, 'gridspace/private-notes', params, grid.token);
const first = await read({ mode: 'mentions', limit: 2 }); assert.ok(first.cursor);
await assert.rejects(read({ mode: 'direct', cursor: first.cursor, limit: 2 }));
let page = first; const ids = [];
for (let i = 0; i < 10; i++) { ids.push(...page.notes.map(note => note.id)); if (!page.cursor) break; page = await read({ mode: 'mentions', cursor: page.cursor, limit: 2 }); }
assert.equal(new Set(ids).size, ids.length);
for (const note of [publicNote, home, direct, inChannel]) assert.ok(ids.includes(note.id), `Missing ${note.id}`);
for (const note of [denied, unrelated, muted]) assert.ok(!ids.includes(note.id), `Unexpected ${note.id}`);
assert.deepEqual((await read({ mode: 'direct', limit: 20 })).notes.map(note => note.id), [direct.id]);
assert.deepEqual((await read({ mode: 'validate', contextMode: 'direct', ids: [publicNote.id, direct.id, denied.id] })).notes.map(note => note.id), [direct.id]);
await api(r, 'notes/delete', { noteId: home.id }, author.token);
assert.equal((await read({ mode: 'validate', contextMode: 'mentions', ids: [home.id] })).notes.length, 0);
const local = (await api(g, 'notes/create', { text: `Local direct ${suffix}`, visibility: 'specified', visibleUserIds: [grid.id] }, g.admin)).createdNote;
savePrivateJson('.config/gridspace-mentions-test-accounts.json', { grid, old, author, other, direct, publicNote, inChannel, local, suffix });
console.log('Mentions/direct: public + home + explicit recipients + sensitive channel; exclusion of non-recipient/unrelated/muted; paging, scope-bound cursor, same-scope validation, deletion PASS');
// Revocation is tested last by the UI runner after its actual source-account reply.
