/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { api, loadSite, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0), r = loadSite('../resonite-love-gridspace', 1);
async function account(site) {
	const admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
	const password = randomBytes(20).toString('base64url');
	const created = await api(site, 'admin/accounts/create', { username: 'layout31_' + randomBytes(4).toString('hex'), password }, admin.token);
	return { ...await api(site, 'i', {}, created.token), token: created.token, password };
}
const grid = await account(g), old = await account(r), author = await account(r);
const folder = await api(r, 'drive/folders/create', { name: 'Uploads 31' }, old.token);
const foreignFolder = await api(r, 'drive/folders/create', { name: 'Not ours' }, author.token);
const list = await api(r, 'users/lists/create', { name: 'Friends 31' }, old.token);
const sourceProfile = { id: randomUUID(), name: 'Migrated', columns: [{ id: randomUUID(), type: 'list', name: 'Friends', width: 340, listId: list.id }], layout: [] };
sourceProfile.layout = [[sourceProfile.columns[0].id]];
const client = JSON.stringify({ version: 1, values: { uploadFolder: folder.id, 'deck.profile': 'Migrated', 'deck.profiles': [sourceProfile], widgets: [{ id: randomUUID(), name: 'slideshow', data: { folderId: folder.id } }] }, memos: { memo: 'Layout 31 memo', memo2: null } });
const start = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
const transaction = (await (await fetch(start.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
assert.ok(transaction);
const decision = await fetch(r.origin + '/oauth/decision', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token, gridspace_settings: client }) });
assert.equal(decision.status, 302);
const callback = new URL(decision.headers.get('location'));
await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: start.clientKey }, grid.token);
const copied = await api(g, 'gridspace/settings-import', { action: 'start', requestId: randomUUID() }, grid.token);
assert.deepEqual(JSON.parse(copied.client), JSON.parse(client));
let lists = await api(g, 'gridspace/list-import', { action: 'start' }, grid.token);
for (let i = 0; lists.pending && i < 100; i++) lists = await api(g, 'gridspace/list-import', { action: 'step' }, grid.token);
assert.equal(lists.pending, 0);
const mappedList = await api(g, 'gridspace/layout-reference', { kind: 'list', id: list.id }, grid.token);
assert.equal((await api(g, 'users/lists/show', { listId: mappedList.id }, grid.token)).name, list.name);
const mappedFolder = await api(g, 'gridspace/layout-reference', { kind: 'folder', id: folder.id }, grid.token);
assert.equal((await api(g, 'drive/folders/show', { folderId: mappedFolder.id }, grid.token)).name, folder.name);
await assert.rejects(api(g, 'gridspace/layout-reference', { kind: 'folder', id: foreignFolder.id }, grid.token));
console.log('PASS: OAuth preserves layout snapshot; owned list/upload folder resolve; foreign folder refused');

const page = await api(r, 'pages/create', { name: 'liked31-' + Date.now(), title: 'Liked Page 31', content: [{ id: 'text', type: 'text', text: 'Content 31' }], variables: [], script: '' }, author.token);
const form = new FormData(); form.set('i', author.token); form.set('force', 'true'); form.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')], { type: 'image/png' }), 'art.png');
const upload = await fetch(r.origin + '/api/drive/files/create', { method: 'POST', body: form }); assert.equal(upload.status, 200);
const file = await upload.json();
const gallery = await api(r, 'gallery/posts/create', { title: 'Liked Gallery 31', fileIds: [file.id] }, author.token);
const managed = (site, token, kind, action, id, data) => api(site, 'gridspace/managed-resource', { kind, action, id, data }, token);
for (const [kind, item, endpoint, key] of [['page', page, 'pages', 'pageId'], ['gallery', gallery, 'gallery/posts', 'postId']]) {
	await api(r, endpoint + '/like', { [key]: item.id }, old.token);
	let liked = await managed(g, grid.token, kind, 'liked', undefined, { limit: 1 });
	assert.equal(liked.items[0].gridspaceOriginalId, item.id);
	if (kind === 'gallery') assert.equal(liked.items[0].files[0].gridspaceOrigin, r.origin);
	assert.ok(liked.items[0].gridspaceLikeId); assert.ok(Date.parse(liked.items[0].gridspaceLikedAt));
	assert.match(liked.items[0].user.id, /^gridspace:/);
	assert.equal((await api(r, endpoint + '/show', { [key]: item.id }, old.token)).likedCount, 1);
	await managed(g, grid.token, kind, 'like', item.id); // Retry must not increment twice.
	assert.equal((await api(r, endpoint + '/show', { [key]: item.id }, old.token)).likedCount, 1);
	await managed(g, grid.token, kind, 'unlike', item.id);
	assert.equal((await managed(g, grid.token, kind, 'liked')).items.length, 0);
	await managed(g, grid.token, kind, 'like', item.id);
	assert.equal((await api(r, endpoint + '/show', { [key]: item.id }, old.token)).likedCount, 1);
	await api(r, 'blocking/create', { userId: old.id }, author.token);
	assert.equal((await managed(g, grid.token, kind, 'liked')).items.length, 0);
	await assert.rejects(managed(g, grid.token, kind, 'inspect', item.id));
	await managed(g, grid.token, kind, 'unlike', item.id);
	await api(r, 'blocking/delete', { userId: old.id }, author.token);
}
const gridAuthor = await account(g);
const localPage = await api(g, 'pages/create', { name: 'reverse31-' + Date.now(), title: 'Reverse 31', content: [], variables: [], script: '' }, gridAuthor.token);
await api(g, 'pages/like', { pageId: localPage.id }, grid.token);
assert.ok((await managed(r, old.token, 'page', 'liked')).items.some(item => item.gridspaceOriginalId === localPage.id));
assert.equal((await managed(r, author.token, 'page', 'liked')).enabled, false);
console.log('PASS: shared likes, duplicate retries, unlink-free visibility revocation, reverse direction and unlinked native behavior');
savePrivateJson('.config/layout31-accounts.json', { grid, old, author, page, gallery, localPage, folder, mappedFolder, mappedList });
