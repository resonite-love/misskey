/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount, seedProfile } from './test-profile-import.mjs';
const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g); const old = await makeProfileAccount(r);
const blocked = await makeProfileAccount(r); const muted = await makeProfileAccount(r);
const admins = [g, r].map(site => JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin);
const original = await seedProfile(r, old);
const file = await api(r, 'drive/files/show', { fileId: original.avatarId }, old.token);
const definition = { name: `Decoration ${old.id}`, description: 'Portable catalog', url: file.url, category: 'Test', roleIdsThatCanBeUsedThisDecoration: [] };
const rDecoration = await api(r, 'admin/avatar-decorations/create', definition, admins[1].token);
const gDecoration = await api(g, 'admin/avatar-decorations/create', definition, admins[0].token);
const transforms = { angle: 0.2, flipH: true, offsetX: 0.1, offsetY: -0.15 };
await api(r, 'i/update', { isLocked: true, followingVisibility: 'private', mutedWords: [['secret-word']], avatarDecorations: [{ id: rDecoration.id, ...transforms }] }, old.token);
await api(r, 'blocking/create', { userId: blocked.id }, old.token);
await api(r, 'mute/create', { userId: muted.id, expiresAt: null }, old.token);
const oldList = await api(r, 'users/lists/create', { name: 'Source filter' }, old.token);
await api(r, 'i/update', { notificationRecieveConfig: { reaction: { type: 'list', userListId: oldList.id } } }, old.token);
await api(g, 'i/update', { notificationRecieveConfig: { reaction: { type: 'following' } } }, grid.token);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ grid, old, gOrigin, rOrigin }) => {
		if (![gOrigin, rOrigin].includes(location.origin) || localStorage.getItem('settings19-seeded')) return;
		const source = location.origin === rOrigin;
		localStorage.setItem('account', JSON.stringify(source ? old : grid));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		localStorage.setItem('preferences', JSON.stringify({ id: 'settings19', type: 'main', version: '1', modifiedAt: Date.now(), name: 'test', preferences: {
			defaultNoteVisibility: [[{}, source ? 'followers' : 'public', {}]], defaultNoteLocalOnly: [[{}, source, {}]],
			'sound.on.notification': [[{}, { type: null, volume: 0 }, {}]], animation: [[{}, !source, {}]],
		} }));
		localStorage.setItem('settings19-seeded', 'true');
	}, { grid, old, gOrigin: g.origin, rOrigin: r.origin });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	let first = true;
	await page.route(`${g.origin}/api/gridspace/settings-import`, async route => {
		if (first && route.request().postDataJSON().action === 'start') { first = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort(); }
		else await route.continue();
	});
	async function consent() {
		await page.waitForURL(`${r.origin}/oauth/authorize**`);
		const accept = page.getByRole('button', { name: '許可', exact: true }); const next = page.getByRole('button', { name: '続ける', exact: false });
		await expect(accept.or(next)).toBeVisible();
		if (!await accept.isVisible()) { await page.locator(`label[for="account-${old.id}"]`).click(); await next.click(); }
		await accept.click(); await page.waitForURL(`${g.origin}/settings/gridspace**`);
	}
	async function preference(key) {
		return page.evaluate(({ key, id }) => {
			const rows = JSON.parse(localStorage.getItem('preferences')).preferences[key];
			return (rows.find(([s]) => s.account === id) ?? rows.find(([s]) => s.account == null))[1];
		}, { key, id: grid.id });
	}
	await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: '連携して設定を引き継ぐ', exact: true }).click(); await consent();
	await expect(page.getByRole('alert').filter({ hasText: '一部の設定を引き継げませんでした' })).toBeVisible();
	await page.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: '設定を引き継ぎました。' })).toBeVisible();
	let copied = await api(g, 'i', {}, grid.token);
	assert.equal(copied.isLocked, true); assert.equal(copied.followingVisibility, 'private'); assert.deepEqual(copied.mutedWords, [['secret-word']]);
	assert.deepEqual(copied.notificationRecieveConfig.reaction, { type: 'following' });
	assert.equal(copied.avatarDecorations[0].id, gDecoration.id);
	for (const [key, value] of Object.entries(transforms)) assert.equal(copied.avatarDecorations[0][key], value);
	assert.equal(await preference('defaultNoteVisibility'), 'followers'); assert.equal(await preference('defaultNoteLocalOnly'), true);
	assert.deepEqual(await preference('sound.on.notification'), { type: null, volume: 0 });
	const blockRows = await api(g, 'blocking/list', { limit: 100 }, grid.token);
	const muteRows = await api(g, 'mute/list', { limit: 100 }, grid.token);
	assert.ok(blockRows.some(row => row.blockee.username === blocked.username)); assert.ok(muteRows.some(row => row.mutee.username === muted.username && row.expiresAt === null));
	console.log('Automatic OAuth settings, decoration ID/transform mapping, disabled sound, private notifications, mute/block copy, lost response retry PASS');
	await api(g, 'i/update', { isLocked: false }, grid.token);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.getByRole('button', { name: 'れぞらぶの設定を引き継ぐ', exact: true })).toBeVisible();
	assert.equal((await api(g, 'i', {}, grid.token)).isLocked, false);
	await page.getByRole('button', { name: 'れぞらぶの設定を引き継ぐ', exact: true }).click(); await consent();
	await expect(page.getByRole('status').filter({ hasText: '設定を引き継ぎました。' })).toBeVisible();
	copied = await api(g, 'i', {}, grid.token); assert.equal(copied.isLocked, true);
	assert.equal((await api(g, 'blocking/list', { limit: 100 }, grid.token)).length, blockRows.length);
	console.log('Reload preserves subsequent edits; explicit second OAuth import replaces settings without stale-job failures or duplicate blocks PASS');
	await api(r, 'admin/avatar-decorations/delete', { id: rDecoration.id }, admins[1].token);
	assert.equal((await api(g, 'gridspace/profile-import', {}, grid.token)).complete, true);
	console.log('Deleted source decoration does not break profile export PASS');
	await page.screenshot({ path: '.config/settings19-desktop.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'れぞらぶの設定を引き継ぐ', exact: true }).scrollIntoViewIfNeeded();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: '.config/settings19-mobile.png', fullPage: true }); assert.deepEqual(errors, []);
} finally { await browser.close(); }
