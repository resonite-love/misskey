/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { api, loadSite, eventually } from './lab.mjs';
import { makeProfileAccount } from './test-profile-import.mjs';

const g = loadSite('.', 0), r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g), old = await makeProfileAccount(r), outsider = await makeProfileAccount(g);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function upload(site, account, name, folderId) {
	const form = new FormData(); form.set('i', account.token); form.set('force', 'true'); form.set('name', name);
	form.set('file', new Blob([png], { type: 'image/png' }), name); if (folderId) form.set('folderId', folderId);
	const response = await fetch(site.origin + '/api/drive/files/create', { method: 'POST', body: form });
	assert.equal(response.status, 200); return response.json();
}
const gf = await api(g, 'drive/folders/create', { name: 'G folder' }, grid.token);
const rf = await api(r, 'drive/folders/create', { name: 'R folder' }, old.token);
const a = await upload(g, grid, 'G-file.png', gf.id), b = await upload(r, old, 'R-file.png', rf.id);
const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
const decision = await fetch(r.origin + '/oauth/decision', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
assert.equal(decision.status, 302); const callback = new URL(decision.headers.get('location'));
await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
assert.equal((await api(g, 'gridspace/link', {}, grid.token)).driveShared, true);
assert.equal((await api(r, 'gridspace/link', {}, old.token)).driveShared, true);
let rgFolder, grFolder, aRef, bRef;
await eventually('both native folder lists include the partner folders', async () => {
	rgFolder = (await api(r, 'drive/folders', {}, old.token)).find(folder => folder.name === 'G folder');
	grFolder = (await api(g, 'drive/folders', {}, grid.token)).find(folder => folder.name === 'R folder');
	return !!rgFolder && !!grFolder;
}, 60000);
await eventually('both native file lists include partner files', async () => {
	aRef = (await api(r, 'drive/files', { folderId: rgFolder.id }, old.token)).find(file => file.name === a.name);
	bRef = (await api(g, 'drive/files', { folderId: grFolder.id }, grid.token)).find(file => file.name === b.name);
	return !!aRef && !!bRef;
}, 60000);
assert.equal(aRef.url, a.url); assert.equal(bRef.url, b.url);
assert.notEqual(aRef.id, a.id); assert.notEqual(bRef.id, b.id);
console.log('PASS: ordinary lists combine both trees, using the original file URLs');

const fromR = (await api(r, 'notes/create', { text: 'shared Drive G reference', fileIds: [aRef.id] }, old.token)).createdNote;
const fromG = (await api(g, 'notes/create', { text: 'shared Drive R reference', fileIds: [bRef.id] }, grid.token)).createdNote;
assert.equal(fromR.files[0].url, a.url); assert.equal(fromG.files[0].url, b.url);
await assert.rejects(api(g, 'drive/files/update', { fileId: bRef.id, name: 'not allowed' }, outsider.token));
await assert.rejects(api(g, 'gridspace/link', { action: 'revoke' }, grid.token));
assert.equal((await api(g, 'gridspace/link', {}, grid.token)).state, 'active');
console.log('PASS: normal attachment APIs work; other users and self-unlink are refused');

await api(r, 'drive/files/update', { fileId: aRef.id, name: 'renamed.png', comment: 'shared caption', isSensitive: true }, old.token);
assert.equal((await api(g, 'drive/files/show', { fileId: a.id }, grid.token)).name, 'renamed.png');
await api(r, 'drive/files/update', { fileId: aRef.id, folderId: rf.id }, old.token);
assert.equal((await api(g, 'drive/files/show', { fileId: a.id }, grid.token)).folderId, grFolder.id);
await api(g, 'drive/folders/update', { folderId: grFolder.id, name: 'renamed R folder' }, grid.token);
assert.equal((await api(r, 'drive/folders/show', { folderId: rf.id }, old.token)).name, 'renamed R folder');
await api(g, 'drive/folders/update', { folderId: gf.id, parentId: grFolder.id }, grid.token);
await eventually('nested foreign folder is reflected', async () => (await api(r, 'drive/folders/show', { folderId: rgFolder.id }, old.token)).parentId === rf.id);
console.log('PASS: file metadata, cross-server moves, folder names and folder moves reach their owner');

const fresh = await upload(r, old, 'new-after-link.png');
await eventually('new upload appears at G', async () => (await api(g, 'drive/files', {}, grid.token)).some(file => file.url === fresh.url));
await api(r, 'drive/files/delete', { fileId: aRef.id }, old.token);
await assert.rejects(api(g, 'drive/files/show', { fileId: a.id }, grid.token));
await assert.rejects(api(r, 'drive/files/show', { fileId: aRef.id }, old.token));
await api(g, 'drive/files/delete', { fileId: bRef.id }, grid.token);
await assert.rejects(api(r, 'drive/files/show', { fileId: b.id }, old.token));
await assert.rejects(api(g, 'drive/folders/delete', { folderId: grFolder.id }, grid.token));
await api(g, 'drive/folders/update', { folderId: gf.id, parentId: null }, grid.token);
await eventually('folder move out reaches R', async () => (await api(r, 'drive/folders/show', { folderId: rgFolder.id }, old.token)).parentId === null);
await api(g, 'drive/folders/delete', { folderId: grFolder.id }, grid.token);
await assert.rejects(api(r, 'drive/folders/show', { folderId: rf.id }, old.token));
console.log('PASS: new uploads appear; both directions delete the original and reference; nonempty folders are protected');
