/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount } from './test-profile-import.mjs';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g); const old = await makeProfileAccount(r);
const list = await api(r, 'users/lists/create', { name: 'Antenna members' }, old.token);
await api(r, 'users/lists/push', { listId: list.id, userId: old.id }, old.token);
const antennaParams = { name: 'Antenna import', src: 'users', userListId: null, users: [old.username], keywords: [['collections24']], excludeKeywords: [['exclude']], caseSensitive: true, localOnly: false, excludeBots: true, withReplies: true, withFile: false, excludeNotesInSensitiveChannel: true };
await api(r, 'antennas/create', antennaParams, old.token);
await api(r, 'antennas/create', { ...antennaParams, name: 'List antenna', src: 'list', userListId: list.id }, old.token);
await api(r, 'antennas/create', { ...antennaParams, name: 'All posts with blank users', src: 'all', users: [''] }, old.token);
const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
assert.equal(decision.status, 302); const callback = new URL(decision.headers.get('location'));
await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);

let state = await api(g, 'gridspace/list-import', { action: 'start' }, grid.token);
for (let i = 0; state.pending && i < 20; i++) state = await api(g, 'gridspace/list-import', { action: 'step' }, grid.token);
assert.equal(state.complete, true); assert.equal(state.failed, 0);
const antennas = await api(g, 'antennas/list', {}, grid.token);
assert.equal(antennas.length, 3);
assert.deepEqual(antennas.find(a => a.src === 'all').users, []);
const copied = antennas.find(a => a.name === antennaParams.name);
for (const key of ['keywords', 'excludeKeywords', 'caseSensitive', 'localOnly', 'excludeBots', 'withReplies', 'withFile', 'excludeNotesInSensitiveChannel']) assert.deepEqual(copied[key], antennaParams[key], key);
assert.deepEqual(copied.users, [`${old.username}@${new URL(r.origin).host}`]);
const lists = await api(g, 'users/lists/list', {}, grid.token);
assert.equal(antennas.find(a => a.src === 'list').userListId, lists[0].id);
await api(g, 'gridspace/list-import', { action: 'start' }, grid.token);
assert.equal((await api(g, 'antennas/list', {}, grid.token)).length, 3);
console.log('PASS: antenna conditions, list IDs and source account hosts copied without duplication');

const publicNote = (await api(r, 'notes/create', { text: `collections24 public ${old.id}`, localOnly: true }, old.token)).createdNote;
const homeNote = (await api(r, 'notes/create', { text: `collections24 home ${old.id}`, visibility: 'home', localOnly: true }, old.token)).createdNote;
const privateNote = (await api(r, 'notes/create', { text: 'collections24 private', visibility: 'specified', visibleUserIds: [old.id] }, old.token)).createdNote;
for (const note of [publicNote, homeNote, privateNote]) await api(r, 'notes/favorites/create', { noteId: note.id }, old.token);
const clip = await api(r, 'clips/create', { name: 'Renote clip', isPublic: false }, old.token);
await api(r, 'clips/add-note', { clipId: clip.id, noteId: publicNote.id }, old.token);
const favoriteRows = await api(g, 'gridspace/private-notes', { mode: 'favorites' }, grid.token);
assert.ok(favoriteRows.notes.some(n => n.id === publicNote.id));
assert.ok((await api(g, 'gridspace/private-notes', { mode: 'clip', clipId: clip.id }, grid.token)).notes.some(n => n.id === publicNote.id));
for (const note of [publicNote, homeNote]) {
	const target = await api(g, 'gridspace/renote-target', { noteId: note.id }, grid.token);
	assert.equal(target.uri, `${r.origin}/notes/${note.id}`); assert.equal(target.localOnly, true);
	const rn = (await api(g, 'notes/create', { renoteId: target.id }, grid.token)).createdNote;
	assert.equal(rn.renoteId, target.id); assert.equal(rn.localOnly, true);
}
await assert.rejects(api(g, 'gridspace/renote-target', { noteId: privateNote.id }, grid.token), e => e.code === 'GRIDSPACE_RENOTE_UNAVAILABLE');
console.log('PASS: public/home favorites and clips resolve native RN IDs; local-only preserved; direct posts rejected');

const { chromium } = createRequire(resolve('packages/frontend/package.json'))('playwright');
const { expect } = createRequire(resolve('packages/frontend/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ account, origin }) => {
		if (location.origin !== origin) return;
		localStorage.setItem('account', JSON.stringify(account)); localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { account: grid, origin: g.origin });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	for (const route of ['/my/favorites', `/clips/${clip.id}/linked`]) {
		await page.goto(g.origin + route);
		const row = page.locator('[data-gridspace-private-note]').filter({ hasText: publicNote.text });
		await expect(row).toBeVisible();
		await row.getByRole('button', { name: 'リノート', exact: true }).click();
		await expect(page.getByRole('menuitem', { name: /引用$/ })).toBeVisible();
		const response = page.waitForResponse(res => res.url().endsWith('/api/notes/create') && res.request().method() === 'POST');
		await page.getByRole('menuitem', { name: /リノート$/ }).click();
		assert.ok((await response).ok());
		await row.getByRole('button', { name: 'リノート', exact: true }).click();
		await page.getByRole('menuitem', { name: /引用$/ }).click();
		await expect(page.getByTestId('post-form-text')).toBeVisible();
		await page.getByTestId('post-form-text').fill('collections24 quote');
		await page.screenshot({ path: `.config/collections24-${route.includes('favorites') ? 'favorite' : 'clip'}-quote.png`, fullPage: true });
		const posted = page.waitForResponse(res => res.url().endsWith('/api/notes/create') && res.request().method() === 'POST');
		await page.getByTestId('post-form-submit').click();
		const quoted = await (await posted).json();
		assert.ok(quoted.createdNote.renoteId); assert.equal(quoted.createdNote.localOnly, true);
	}
	await page.goto(g.origin + '/my/antennas');
	await expect(page.getByRole('link', { name: 'Antenna import', exact: true })).toBeVisible();
	await page.screenshot({ path: '.config/collections24-antennas.png', fullPage: true });
	assert.deepEqual(errors, []);
	console.log('PASS: native RN menu and quote composer in favorites and clips; ordinary antenna list; no browser errors');
} finally { await browser.close(); }

await api(g, 'antennas/delete', { antennaId: copied.id }, grid.token);
await api(g, 'gridspace/list-import', { action: 'retry' }, grid.token);
assert.equal((await api(g, 'antennas/list', {}, grid.token)).length, 2);
await api(g, 'gridspace/link', { action: 'revoke' }, grid.token);
await assert.rejects(api(g, 'gridspace/renote-target', { noteId: publicNote.id }, grid.token));
console.log('PASS: manual antenna deletion retained and link revocation blocks RN preparation');
