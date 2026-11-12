/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount } from './test-profile-import.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g); const old = await makeProfileAccount(r); const author = await makeProfileAccount(r);
const admin = JSON.parse(readFileSync(r.accountsPath, 'utf8')).accounts.admin;
const role = await api(r, 'admin/roles/create', { name: `Collections ${old.id}`, description: 'Dedicated lab fixture', color: null, iconUrl: null, target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } } }, admin.token);
await api(r, 'admin/roles/assign', { roleId: role.id, userId: old.id }, admin.token);
const sourceList = await api(r, 'users/lists/create', { name: `Friends ${old.id}` }, old.token);
await api(r, 'users/lists/push', { listId: sourceList.id, userId: author.id }, old.token);
await api(r, 'users/lists/update-membership', { listId: sourceList.id, userId: author.id, withReplies: true }, old.token);
const localList = await api(g, 'users/lists/create', { name: sourceList.name }, grid.token);
const notes = [];
for (let i = 0; i < 22; i++) {
	const note = (await api(r, 'notes/create', { text: `collection ${old.id} ${i}`, visibility: i % 2 ? 'public' : 'specified', visibleUserIds: i % 2 ? undefined : [old.id], localOnly: true }, old.token)).createdNote;
	notes.push(note);
	await api(r, 'notes/favorites/create', { noteId: note.id }, old.token);
}
// Favorite an older note last: collection order must not use publication time.
await api(r, 'notes/favorites/delete', { noteId: notes[0].id }, old.token);
await api(r, 'notes/favorites/create', { noteId: notes[0].id }, old.token);
const localNote = (await api(g, 'notes/create', { text: `local favorite ${grid.id}`, visibility: 'specified', visibleUserIds: [grid.id] }, grid.token)).createdNote;
await api(g, 'notes/favorites/create', { noteId: localNote.id }, grid.token);
const sourceClip = await api(r, 'clips/create', { name: `Private clip ${old.id}`, description: 'Linked **clip**', isPublic: false }, old.token);
await api(r, 'clips/add-note', { clipId: sourceClip.id, noteId: notes[1].id }, old.token);
await api(r, 'clips/add-note', { clipId: sourceClip.id, noteId: notes[0].id }, old.token);
const publicClip = await api(r, 'clips/create', { name: `Public clip ${author.id}`, isPublic: true }, author.token);
await api(r, 'clips/favorite', { clipId: publicClip.id }, old.token);
const localClip = await api(g, 'clips/create', { name: `Local clip ${grid.id}`, isPublic: false }, grid.token);

async function consent() {
	const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
	const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
	const response = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
	assert.equal(response.status, 302); const callback = new URL(response.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
}
await consent();
const status = await api(g, 'gridspace/collections', {}, grid.token); assert.equal(status.favorites, true); assert.equal(status.clipFavorites, true);
const first = await api(g, 'gridspace/private-notes', { mode: 'favorites', limit: 20 }, grid.token);
assert.equal(first.notes.length, 20); assert.equal(first.notes[0].id, notes[0].id); assert.ok(first.cursor);
const next = await api(g, 'gridspace/private-notes', { mode: 'favorites', limit: 20, cursor: first.cursor }, grid.token);
assert.equal(next.notes.length, 2); assert.equal(next.cursor, null); assert.equal(new Set([...first.notes, ...next.notes].map(n => n.id)).size, 22);
await assert.rejects(api(g, 'gridspace/private-notes', { mode: 'clip', clipId: sourceClip.id, cursor: first.cursor }, grid.token));
const clipNotes = await api(g, 'gridspace/private-notes', { mode: 'clip', clipId: sourceClip.id }, grid.token);
assert.deepEqual(clipNotes.notes.map(n => n.id), [notes[1].id, notes[0].id]);
assert.equal((await api(g, 'gridspace/collections', { kind: 'clips', clipId: sourceClip.id }, grid.token)).clipsList[0].isPublic, false);
const stranger = await makeProfileAccount(g);
await assert.rejects(api(g, 'gridspace/private-notes', { mode: 'clip', clipId: sourceClip.id }, stranger.token));
console.log('Favorites addition order, independent cursor, native clip order, private clip access and unlinked isolation PASS');

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ grid, origin }) => {
		if (location.origin !== origin) return;
		localStorage.setItem('account', JSON.stringify(grid)); localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { grid, origin: g.origin });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${g.origin}/my/lists`);
	await page.getByRole('button', { name: 'れぞらぶのリストを引き継ぐ', exact: true }).click();
	await expect(page.getByRole('button', { name: 'れぞらぶのリストを引き継ぐ', exact: true })).toBeDisabled();
	await expect.poll(async () => (await api(g, 'gridspace/list-import', {}, grid.token)).complete).toBe(true);
	const lists = await api(g, 'users/lists/list', {}, grid.token); assert.equal(lists.filter(l => l.name === sourceList.name).length, 2);
	const copied = lists.find(l => l.id !== localList.id); assert.ok(copied); assert.equal(copied.userIds.length, 1);
	await api(g, 'users/lists/delete', { listId: copied.id }, grid.token);
	assert.equal((await api(g, 'gridspace/list-import', { action: 'retry' }, grid.token)).complete, true);
	assert.equal((await api(g, 'users/lists/list', {}, grid.token)).length, 1);
	console.log('Ordinary list button copies alongside same-name list; retry preserves explicit deletion PASS');
	await page.goto(`${g.origin}/my/favorites`);
	await expect(page.getByText(localNote.text, { exact: true })).toBeVisible();
	await expect(page.getByText(notes[0].text, { exact: true })).toBeVisible();
	await page.screenshot({ path: '.config/collections20-favorites.png', fullPage: true });
	await page.goto(`${g.origin}/my/clips`);
	await expect(page.getByText(localClip.name, { exact: true })).toBeVisible();
	await expect(page.getByText(sourceClip.name, { exact: true })).toBeVisible();
	await page.getByText(sourceClip.name, { exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/clips/${sourceClip.id}/linked$`));
	await expect(page.getByText(notes[0].text, { exact: true })).toBeVisible();
	await expect(page.getByText(notes[1].text, { exact: true })).toBeVisible();
	await page.screenshot({ path: '.config/collections20-clip.png', fullPage: true });
	await page.goto(`${g.origin}/my/clips`);

	await page.locator('button').filter({ hasText: /^お気に入り$/ }).click();
	await expect(page.getByText(publicClip.name, { exact: true })).toBeVisible();
	await api(r, 'clips/update', { clipId: publicClip.id, name: publicClip.name, isPublic: false }, author.token);
	await expect(page.getByText(publicClip.name, { exact: true })).toHaveCount(0, { timeout: 25000 });
	console.log('Mixed ordinary favorites/clips, shared clip screen and revoked clip visibility PASS');
	// The local page remains usable when peer reads fail.
	await page.route(`${g.origin}/api/gridspace/collections`, route => route.abort());
	await page.goto(`${g.origin}/my/clips`);
	await expect(page.getByText(localClip.name, { exact: true })).toBeVisible();
	await expect(page.getByText('一部のクリップを取得できませんでした。', { exact: true })).toBeVisible();
	await page.unroute(`${g.origin}/api/gridspace/collections`);
	// Hide while the initial peer request is outstanding; returning must finish initialization.
	let release; const delay = new Promise(resolveWait => { release = resolveWait; }); let intercepted = false;
	await page.route(`${g.origin}/api/gridspace/collections`, async route => { if (!intercepted) { intercepted = true; await delay; } await route.continue().catch(() => {}); });
	await page.goto(`${g.origin}/my/clips`, { waitUntil: 'domcontentloaded' });
	await expect.poll(() => intercepted).toBe(true);
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
	release();
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
	await expect(page.getByText(sourceClip.name, { exact: true })).toBeVisible();
	await page.unroute(`${g.origin}/api/gridspace/collections`);
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: '.config/collections20-mobile.png', fullPage: true });
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, grid.token);
	await expect(page.getByText(sourceClip.name, { exact: true })).toHaveCount(0, { timeout: 25000 });
	assert.deepEqual(errors, []);
	console.log('Peer outage, tab resume, mobile layout and grant revocation PASS');
} finally { await browser.close(); }
