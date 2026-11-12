/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-notification-test-accounts.json', 'utf8'));
const accounts = {};
// MFM expands a mention to the full remote handle in the rendered text.
const visibleBody = note => note.text.replace(/^@\S+\s+/, '');
for (const [site, user] of [[g, fixture.grid], [r, fixture.old]]) {
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	accounts[site.origin] = { ...await api(site, 'i', {}, user.token), token: user.token };
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ accounts }) => {
		if (accounts[location.origin]) localStorage.setItem('account', JSON.stringify(accounts[location.origin]));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		window.revokedNotificationUrls = [];
		const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.revokedNotificationUrls.push(url); revoke(url); };
	}, { accounts });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	async function consent() {
		await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
		await page.getByRole('button', { name: '連携の権限をまとめて更新', exact: true }).click();
		await page.waitForURL(`${r.origin}/oauth/authorize**`);
		const accept = page.getByRole('button', { name: '許可', exact: true });
		await expect(accept.or(page.getByRole('button', { name: '続ける', exact: false }))).toBeVisible();
		if (!await accept.isVisible()) { await page.locator(`label[for="account-${fixture.old.id}"]`).click(); await page.getByRole('button', { name: '続ける', exact: false }).click(); }
		await expect(page.getByText('連携先でこのアカウントの通知を読む', { exact: true })).toBeVisible();
		await expect(page.getByText('連携先で表示したこのアカウントの通知を既読にする', { exact: true })).toBeVisible();
		await accept.click(); await page.waitForURL(`${g.origin}/settings/gridspace**`);
		await expect(page.getByText('限定投稿の閲覧・検索、通知、連携先のアカウント名義での返信・リアクション・投票・添付を利用できます。', { exact: true })).toBeVisible();
	}
	await consent(); console.log('Browser OAuth notification scopes and callback PASS');
	// An unknown link state must not fall back to legacy auto-mark-all APIs.
	const legacyRequests = [];
	page.on('request', request => { if (/\/api\/i\/notifications(?:-grouped)?$/.test(request.url())) legacyRequests.push(request.url()); });
	await page.route('**/api/gridspace/private-grant', route => route.abort());
	await page.goto(`${g.origin}/my/notifications`, { waitUntil: 'domcontentloaded' });
	await expect(page.getByRole('status').filter({ hasText: '一部の通知を取得できません' })).toBeVisible();
	assert.deepEqual(legacyRequests, []);
	await page.unroute('**/api/gridspace/private-grant');
	console.log('Initial grant status outage does not auto-read through legacy notifications PASS');
	await page.route('**/api/gridspace/notifications/read', route => route.abort());
	await api(g, 'notifications/test-notification', {}, fixture.grid.token);
	await page.goto(`${g.origin}/my/notifications`, { waitUntil: 'domcontentloaded' });
	const rows = page.locator('[data-notification-key]');
	await expect(rows.first()).toBeVisible();
	await expect(page.locator('[data-gridspace-private-note]').filter({ hasText: visibleBody(fixture.live) })).toBeVisible();
	assert.ok(await rows.filter({ hasText: new URL(g.origin).host }).count());
	assert.ok(await rows.filter({ hasText: new URL(r.origin).host }).count());
	await expect(page.getByText('既読にできませんでした。もう一度操作してください。', { exact: true })).toBeVisible();
	assert.ok(await rows.count(), 'Read failure must preserve fetched notification rows');
	await page.unroute('**/api/gridspace/notifications/read');
	// Page-header actions expose their text through the tooltip, not aria-label.
	const allRead = page.locator('button').filter({ has: page.locator('i.ti-check') });
	await allRead.hover();
	await expect(page.getByText('両サーバーの通知をすべて既読にする', { exact: true })).toBeVisible();
	await allRead.click();
	await expect.poll(async () => (await api(r, 'i', {}, fixture.old.token)).unreadNotificationsCount).toBe(0);
	await expect.poll(async () => (await api(g, 'i', {}, fixture.grid.token)).unreadNotificationsCount).toBe(0);
	console.log('Read failure preserves rows; explicit all-read clears both source counts PASS');
	await page.screenshot({ path: '.config/notifications-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '.config/notifications-mobile.png' });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	console.log('Normal notification list combines both recipients and private mention; desktop/mobile PASS');
	const live = (await api(r, 'notes/create', { text: `@${fixture.old.username} notification-live-update`, visibility: 'specified', localOnly: true, visibleUserIds: [fixture.old.id] }, fixture.author.token)).createdNote;
	await expect(page.locator('[data-gridspace-private-note]').filter({ hasText: visibleBody(live) })).toBeVisible({ timeout: 30000 });
	await api(r, 'notes/delete', { noteId: live.id }, fixture.author.token);
	await expect(page.locator('[data-gridspace-private-note]').filter({ hasText: visibleBody(live) })).toHaveCount(0, { timeout: 30000 });
	console.log('Peer new notification and deleted-note revalidation without reload PASS');
	const card = page.locator('[data-gridspace-private-note]').filter({ hasText: visibleBody(fixture.live) });
	await card.getByRole('button', { name: '添付ファイルを表示: notification.png', exact: true }).click();
	await expect(card.locator('img[src^="blob:"]')).toBeVisible();
	const blob = await card.locator('img[src^="blob:"]').getAttribute('src');
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, fixture.grid.token);
	await expect(page.locator('[data-gridspace-private-note]')).toHaveCount(0, { timeout: 30000 });
	assert.ok(await page.evaluate(url => window.revokedNotificationUrls.includes(url), blob));
	console.log('Grant revocation clears protected notification text and attachment blobs PASS');
	await consent();
	await page.route('**/api/gridspace/notifications', async route => {
		if (route.request().postDataJSON().source === 'peer') await route.abort(); else await route.continue();
	});
	await page.goto(`${g.origin}/my/notifications`, { waitUntil: 'domcontentloaded' });
	await expect(page.getByText('一部の通知を取得できません。取得できた通知を表示しています。', { exact: false })).toBeVisible();
	await expect(rows.first()).toBeVisible(); assert.equal(await page.locator('[data-gridspace-private-note]').count(), 0);
	await page.unroute('**/api/gridspace/notifications'); await page.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(card).toBeVisible();
	console.log('Peer outage keeps local notifications usable, retry restores peer PASS');
	// Exercise the actual v-appear directive when paging grows an existing group.
	const source = (await api(g, 'gridspace/private-notes', { mode: 'show', noteId: fixture.live.id }, fixture.grid.token)).notes[0];
	const at = n => new Date(1700000000000 + n * 1000).toISOString();
	const notices = [9, 7].map(n => ({ id: `group${n}`, type: 'renote', createdAt: at(n), isRead: false, user: source.author, body: null, reaction: null,
		note: { ...source, id: `note${n}`, renoteId: 'sameOriginal', files: [] } }));
	const seen = new Set();
	await page.route('**/api/gridspace/notifications/read', async route => {
		for (const id of route.request().postDataJSON().ids ?? []) seen.add(id);
		await route.fulfill({ json: { unreadCount: 0 } });
	});
	await page.route('**/api/gridspace/notifications', async route => {
		const p = route.request().postDataJSON();
		await route.fulfill({ json: { origin: p.source === 'peer' ? r.origin : g.origin, recipientId: p.source === 'peer' ? fixture.old.id : fixture.grid.id,
			local: [], remote: p.source === 'peer' ? p.before || p.ids ? notices : [notices[0]] : [],
			next: p.source === 'peer' && !p.before && !p.ids ? 'older' : null, newest: 'group9', boundary: at(8), unreadCount: 2 } });
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect.poll(() => seen.has('group9') && seen.has('group7'), { timeout: 30000 }).toBe(true);
	assert.equal(await rows.count(), 1);
	await page.unroute('**/api/gridspace/notifications'); await page.unroute('**/api/gridspace/notifications/read');
	console.log('Renote grouping and viewport-read after group membership grows PASS');
	assert.deepEqual(errors, []);
} finally { await browser.close(); }
