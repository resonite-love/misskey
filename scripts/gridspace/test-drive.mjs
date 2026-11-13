/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount } from './test-profile-import.mjs';

const g = loadSite('.', 0), r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g), old = await makeProfileAccount(r), other = await makeProfileAccount(r);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function upload(owner, name, folderId) {
	const form = new FormData(); form.set('i', owner.token); form.set('name', name); form.set('force', 'true'); form.set('comment', 'Original caption');
	form.set('file', new Blob([png], { type: 'image/png' }), name); if (folderId) form.set('folderId', folderId);
	const response = await fetch(r.origin + '/api/drive/files/create', { method: 'POST', body: form }); assert.equal(response.status, 200); return response.json();
}
async function link(drivePermission) {
	const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
	const authorization = new URL(started.authorizationUrl);
	if (!drivePermission) authorization.searchParams.set('scope', authorization.searchParams.get('scope').split(' ').filter(scope => scope !== 'read:drive').join(' '));
	const transaction = (await (await fetch(authorization)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
	const response = await fetch(r.origin + '/oauth/decision', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) }); assert.equal(response.status, 302);
	const callback = new URL(response.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
}

const parent = await api(r, 'drive/folders/create', { name: 'Photos' }, old.token);
const child = await api(r, 'drive/folders/create', { name: 'Nested', parentId: parent.id }, old.token);
const foreign = await api(r, 'drive/folders/create', { name: 'Other owner' }, other.token);
const rootFile = await upload(old, 'root.png');
await upload(old, 'another.png');
const nestedFile = await upload(old, 'nested.png', child.id);
const otherFile = await upload(other, 'private.png', foreign.id);
assert.equal((await api(g, 'gridspace/drive', {}, grid.token)).granted, false);
await link(false);
assert.equal((await api(g, 'gridspace/drive', {}, grid.token)).granted, false);
await assert.rejects(api(g, 'gridspace/drive', { mode: 'file', fileId: rootFile.id }, grid.token));
await link(true);
assert.equal((await api(g, 'gridspace/drive', {}, grid.token)).granted, true);
const first = await api(g, 'gridspace/drive', { mode: 'list', limit: 1 }, grid.token);
assert.equal(first.files.length, 1); assert.ok(first.filesNext); assert.equal(first.folders[0].id, parent.id);
const next = await api(g, 'gridspace/drive', { mode: 'list', limit: 1, filesBefore: first.filesNext }, grid.token);
assert.equal(next.files.length, 1); assert.notEqual(next.files[0].id, first.files[0].id);
const nested = await api(g, 'gridspace/drive', { mode: 'list', folderId: child.id, type: 'image/*' }, grid.token);
assert.deepEqual(nested.path.map(f => f.id), [parent.id, child.id]); assert.equal(nested.files[0].id, nestedFile.id);
await assert.rejects(api(g, 'gridspace/drive', { mode: 'list', folderId: foreign.id }, grid.token));
await assert.rejects(api(g, 'gridspace/drive', { mode: 'file', fileId: otherFile.id }, grid.token));
await assert.rejects(api(r, 'gridspace/drive', { mode: 'file', fileId: rootFile.id }, old.token));
console.log('PASS: explicit Drive scope, nested owner-only browsing, pagination, type filter and reverse direction rejection');

const copied = await api(g, 'gridspace/drive-import', { fileId: nestedFile.id }, grid.token);
assert.equal(copied.md5, nestedFile.md5); assert.equal(copied.name, nestedFile.name); assert.equal(copied.comment, nestedFile.comment); assert.notEqual(copied.id, nestedFile.id);
assert.equal((await api(g, 'gridspace/drive-import', { fileId: nestedFile.id }, grid.token)).id, copied.id);
assert.notEqual((await api(g, 'gridspace/drive-import', { fileId: rootFile.id }, grid.token)).id, copied.id);
assert.equal((await api(g, 'drive/files/show', { fileId: copied.id }, grid.token)).userId, grid.id);
const note = (await api(g, 'notes/create', { text: 'Linked Drive attachment', fileIds: [copied.id] }, grid.token)).createdNote;
assert.equal(note.files[0].id, copied.id);
assert.equal((await api(r, 'drive/files/show', { fileId: nestedFile.id }, old.token)).id, nestedFile.id);
await assert.rejects(api(g, 'gridspace/drive-import', { fileId: otherFile.id }, grid.token));
await api(r, 'drive/files/update', { fileId: nestedFile.id, name: 'renamed-without-extension', isSensitive: true }, old.token);
const renamed = await api(g, 'gridspace/drive-import', { fileId: nestedFile.id }, grid.token);
assert.equal(renamed.name, 'renamed-without-extension'); assert.equal(renamed.isSensitive, true); assert.notEqual(renamed.id, copied.id);
assert.equal((await api(g, 'gridspace/drive-import', { fileId: nestedFile.id }, grid.token)).id, renamed.id);
await api(r, 'drive/files/update', { fileId: nestedFile.id, name: 'nested.png', isSensitive: false }, old.token);
console.log('PASS: normal local attachment, content hash/caption, ownership, source preservation and foreign file rejection');

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ user, origin }) => { if (location.origin === origin) { localStorage.setItem('account', JSON.stringify(user)); localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true'); } }, { user: grid, origin: g.origin });
	const page = await context.newPage(); page.setDefaultTimeout(30000); const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(g.origin + '/my/drive');
	await page.getByRole('button', { name: 'れぞらぶのドライブ', exact: true }).click();
	await page.getByRole('button', { name: 'Photos', exact: true }).click();
	await page.getByRole('button', { name: 'Nested', exact: true }).click();
	await page.getByRole('button', { name: 'nested.png', exact: true }).click();
	await expect(page.getByRole('link', { name: 'ダウンロード', exact: true })).toBeVisible();
	await page.screenshot({ path: '.config/drive26-browse.png', fullPage: true });
	await page.goto(g.origin + '/');
	await page.getByRole('button', { name: /ノート/ }).first().click();
	await expect(page.getByTestId('post-form-text')).toBeVisible();
	await page.locator('button:has(.ti-cloud-download)').click();
	await page.getByRole('button', { name: 'れぞらぶのドライブ', exact: true }).click();
	await page.getByRole('button', { name: 'another.png', exact: true }).click();
	await page.getByRole('button', { name: /完了/ }).click();
	await page.getByTestId('post-form-text').fill('Drive picker attachment');
	await page.screenshot({ path: '.config/drive26-picker.png', fullPage: true });
	const posted = page.waitForResponse(response => response.url().endsWith('/api/notes/create') && response.request().method() === 'POST');
	await page.getByTestId('post-form-submit').click();
	const body = await (await posted).json(); assert.equal(body.createdNote.files.length, 1); assert.equal(body.createdNote.files[0].md5, rootFile.md5);
	assert.deepEqual(errors, []);
	await api(g, 'gridspace/link', { action: 'revoke' }, grid.token);
	await assert.rejects(api(g, 'gridspace/drive-import', { fileId: nestedFile.id }, grid.token));
	assert.equal((await api(g, 'drive/files/show', { fileId: copied.id }, grid.token)).id, copied.id);
	console.log('PASS: ordinary Drive browsing, post file picker, attachment submission, revocation and retained local copy');
} finally { await browser.close(); }
