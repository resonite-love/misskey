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
const grid = await makeProfileAccount(g), old = await makeProfileAccount(r);
const title = `Content27 ${old.id}`;
const create = (site, account, name) => api(site, 'pages/create', { title: name, name: `content${Date.now()}`, content: [{ id: 'text', type: 'text', text: 'A linked page with **MFM**.' }], variables: [], script: '' }, account.token);
const localPage = await create(g, grid, title + ' local');
const remotePage = await create(r, old, title + ' source');
await create(r, old, title + ' second source');
const hidden = await create(r, old, title + ' hidden');
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const db = new Client({ ...r.config.db, database: r.config.db.db, password: r.config.db.pass });
await db.connect();
try { await db.query('UPDATE page SET visibility = $1 WHERE id = $2', ['specified', hidden.id]); } finally { await db.end(); }

// No account link or extra grant is needed to view public works.
const beforeLink = await api(g, 'gridspace/content', { kind: 'pages', itemId: remotePage.id }, grid.token);
assert.equal(beforeLink.pages[0].gridspaceOrigin, r.origin);
assert.equal((await api(g, 'gridspace/content', { kind: 'pages', itemId: hidden.id }, grid.token)).pages.length, 0);
const first = await api(g, 'gridspace/content', { kind: 'pages', limit: 1 }, grid.token);
assert.ok(first.next);
const next = await api(g, 'gridspace/content', { kind: 'pages', limit: 1, before: first.next }, grid.token);
assert.notEqual(first.pages[0].id, next.pages[0].id);
assert.equal((await api(r, 'gridspace/content', { kind: 'pages', itemId: localPage.id }, old.token)).pages[0].id, localPage.id);
console.log('PASS: public reading without linking, private-page exclusion, keyset cursor, both directions');

const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
assert.equal(decision.status, 302); const callback = new URL(decision.headers.get('location'));
await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
assert.ok((await api(g, 'gridspace/content', { kind: 'pages', userId: grid.id }, grid.token)).pages.some(page => page.id === remotePage.id));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const form = new FormData(); form.set('i', old.token); form.set('force', 'true'); form.set('file', new Blob([png], { type: 'image/png' }), 'art.png');
const uploaded = await fetch(r.origin + '/api/drive/files/create', { method: 'POST', body: form }); assert.equal(uploaded.status, 200);
const file = await uploaded.json();
const art = await api(r, 'gallery/posts/create', { title: title + ' art', fileIds: [file.id], description: 'Gallery **MFM**', isSensitive: true }, old.token);
const gallery = (await api(g, 'gridspace/content', { kind: 'gallery', itemId: art.id }, grid.token)).gallery[0];
assert.equal(gallery.files[0].gridspaceOrigin, r.origin); assert.equal(gallery.isSensitive, true);
console.log('PASS: linked profile mapping and source-marked sensitive gallery media');

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
	await page.goto(g.origin + `/@${grid.username}/pages`);
	await expect(page.getByRole('link').filter({ hasText: title + ' source' })).toBeVisible();
	await expect(page.getByRole('link').filter({ hasText: title + ' local' })).toBeVisible();
	await expect(page.locator('button:has(.ti-calendar-clock)')).toBeVisible();
	await page.goto(g.origin + '/@' + old.username + '@' + new URL(r.origin).host + '/pages');
	await expect(page.getByRole('link').filter({ hasText: title + ' local' })).toBeVisible();
	await expect(page.getByRole('link').filter({ hasText: title + ' source' })).toBeVisible();
	await page.getByRole('link').filter({ hasText: title + ' source' }).click();
	await expect(page.getByText('A linked page with', { exact: false })).toBeVisible();
	await expect(page.getByRole('link', { name: /リモートで表示/ })).toHaveAttribute('href', `${r.origin}/@${old.username}/pages/${remotePage.name}`);
	await page.goto(g.origin + `/gridspace/gallery/${art.id}`);
	await expect(page.getByText(title + ' art', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: /リモートで表示/ })).toHaveAttribute('href', `${r.origin}/gallery/${art.id}`);
	await page.waitForTimeout(400);
	await page.screenshot({ path: '.config/content27-gallery.png', fullPage: true });
	await page.goto(g.origin + `/gridspace/pages/${hidden.id}`);
	await expect(page.getByText('A linked page with', { exact: false })).toHaveCount(0);
	assert.deepEqual(errors, []);
	console.log('PASS: native profile cards, Page MFM, sensitive Gallery viewer, source URLs, private page not rendered');
} finally { await browser.close(); }
