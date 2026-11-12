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
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const fixture = JSON.parse(readFileSync('.config/gridspace-private-test-accounts.json', 'utf8'));
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const accounts = {};
for (const [site, user] of [[g, fixture.grid], [r, fixture.resonite]]) {
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	accounts[site.origin] = { ...await api(site, 'i', {}, user.token), token: user.token };
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const roles = [];
try {
	// Repeated consent/revocation scenarios exceed interactive-user request rates.
	// Disable throttling only for these disposable lab accounts, not either server.
	for (const [site, user] of [[g, fixture.grid], [r, fixture.resonite]]) {
		const admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
		const role = await api(site, 'admin/roles/create', {
			name: `Private UI ${Date.now()}`, description: 'Temporary UI test role', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } },
		}, admin.token);
		roles.push({ site, admin, id: role.id });
		await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, admin.token);
	}
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ accounts }) => {
		const account = accounts[location.origin];
		if (account) localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		window.privateRevokedUrls = [];
		const revoke = URL.revokeObjectURL.bind(URL);
		URL.revokeObjectURL = url => { window.privateRevokedUrls.push(url); revoke(url); };
	}, { accounts });
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	async function consent() {
		await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
		await page.getByRole('button', { name: '連携の権限をまとめて更新', exact: true }).click();
		await page.waitForURL(`${r.origin}/oauth/authorize**`);
		const accept = page.getByRole('button', { name: '許可', exact: true });
		await expect(accept.or(page.getByRole('button', { name: '続ける', exact: false }))).toBeVisible({ timeout: 30000 });
		if (!await accept.isVisible()) {
			await page.locator(`label[for="account-${fixture.resonite.id}"]`).click();
			await page.getByRole('button', { name: '続ける', exact: false }).click();
		}
		await expect(page.getByText('連携したアカウントの権限で限定投稿と添付ファイルを閲覧・検索する', { exact: true })).toBeVisible();
		await expect(page.getByText('連携した両アカウントから、お互いの権限で限定投稿を閲覧・検索できるようにする', { exact: true })).toBeVisible();
		await accept.click();
		await page.waitForURL(`${g.origin}/settings/gridspace**`);
		await expect(page.getByText('限定投稿の閲覧・検索、通知、連携先のアカウント名義での返信・リアクション・投票・添付を利用できます。', { exact: false })).toBeVisible({ timeout: 30000 });
	}
	await consent();
	assert.equal((await api(r, 'gridspace/private-grant', {}, fixture.resonite.token)).mutual, true);
	console.log('Real browser OAuth scope consent and settings callback PASS');
	await page.route('**/api/gridspace/private-grant', route => route.fulfill({ json: {
		enabled: true, granted: true, mutual: false, available: false, peerOrigin: r.origin, authorizationUrl: null, clientKey: null,
	} }));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.getByText('連携先との通信に失敗しました。時間をおいて再試行してください。', { exact: true })).toBeVisible();
	await expect(page.getByText('現在の許可は片方向です。', { exact: false })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '連携を解除', exact: true })).toBeEnabled();
	await page.unroute('**/api/gridspace/private-grant');
	console.log('Unavailable grant status preserves revoke access without claiming directional consent PASS');
	await page.goto(`${g.origin}/search`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="search"]').fill(fixture.query);
	await page.getByRole('button', { name: '検索', exact: true }).click();
	let section = page.locator('[data-gridspace-note-list]');
	await expect(section.locator('[data-gridspace-private-note]').first()).toBeVisible({ timeout: 30000 });
	const morePrivate = section.getByRole('button', { name: 'もっと見る', exact: true });
	if (await morePrivate.count()) await morePrivate.click();
	await expect(page.locator('[data-gridspace-private]')).toHaveCount(0);
	await page.screenshot({ path: '.config/private-search-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/private-search-mobile.png' });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	console.log('Default private search results, pagination and mobile layout PASS');
	await page.goto(`${g.origin}/@${fixture.author.username}@${new URL(r.origin).host}/notes`, { waitUntil: 'domcontentloaded' });
	await expect(section.locator('[data-gridspace-private-note]').first()).toBeVisible({ timeout: 30000 });
	console.log('Profile includes old-authorized private history by default PASS');

	const detailUrl = `${g.origin}/gridspace/private?noteId=${fixture.imageNote.id}`;
	// The mixed profile must discard delegated bodies and loaded blobs on real revocation.
	const mixedCard = section.locator('[data-gridspace-private-note]').filter({
		has: page.locator(`a[href="/gridspace/private?noteId=${fixture.imageNote.id}"]`),
	});
	await expect(mixedCard).toBeVisible();
	await mixedCard.locator('summary').click();
	await mixedCard.getByRole('button', { name: '添付ファイルを表示: private.png', exact: true }).click();
	await expect(mixedCard.locator('img[src^="blob:"]')).toBeVisible();
	let mixedBlob = await mixedCard.locator('img[src^="blob:"]').getAttribute('src');
	const row = mixedCard.locator('..');
	const height = await row.evaluate(el => { window.profileAnchor = el; return el.getBoundingClientRect().height; });
	let releaseValidation; const validationGate = new Promise(resolve => { releaseValidation = resolve; });
	let validations = 0; let headReloads = 0;
	await page.route('**/api/gridspace/private-notes', async route => {
		const params = route.request().postDataJSON();
		if (params.mode === 'validate') { validations++; await validationGate; }
		else if (!params.cursor) headReloads++;
		await route.continue();
	});
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
	await expect(section.locator('[data-gridspace-private-note]')).toHaveCount(0);
	assert.ok(await page.evaluate(url => window.privateRevokedUrls.includes(url), mixedBlob));
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
	await expect.poll(() => validations).toBe(1);
	await expect(section.locator('[data-gridspace-private-note]')).toHaveCount(0);
	releaseValidation();
	await expect(mixedCard).toBeVisible();
	await expect(mixedCard.locator('details')).toHaveJSProperty('open', true);
	assert.equal(await row.evaluate(el => el === window.profileAnchor), true);
	assert.ok(await row.evaluate(el => el.getBoundingClientRect().height) >= height - 2);
	assert.equal(headReloads, 0);
	await page.unroute('**/api/gridspace/private-notes');
	await mixedCard.getByRole('button', { name: '添付ファイルを表示: private.png', exact: true }).click();
	await expect(mixedCard.locator('img[src^="blob:"]')).toBeVisible();
	mixedBlob = await mixedCard.locator('img[src^="blob:"]').getAttribute('src');
	console.log('Profile preserves row geometry/CW, clears blobs and reauthorizes without first-page reset PASS');
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, fixture.grid.token);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(section.locator('[data-gridspace-private-note]')).toHaveCount(0);
	assert.ok(await page.evaluate(url => window.privateRevokedUrls.includes(url), mixedBlob));
	console.log('Mixed profile revocation removes delegated bodies and loaded blob URLs PASS');
	await consent();
	await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
	section = page.locator('[data-gridspace-private]');
	await expect(section.locator('article')).toHaveCount(1, { timeout: 30000 });
	await expect(section.getByText('one — 0', { exact: true })).not.toBeVisible();
	await section.locator('summary').click();
	await expect(section.getByText('one — 0', { exact: true })).toBeVisible();
	await section.getByRole('button', { name: '添付ファイルを表示: private.png', exact: true }).click();
	await expect(section.locator('img[src^="blob:"]')).toBeVisible();
	assert.equal(await section.locator('img[src^="blob:"]').evaluate(img => img.complete && img.naturalWidth > 0), true);
	await section.locator('summary').click();
	await expect(section.locator('img[src^="blob:"]')).toHaveCount(0);
	await expect(section.getByText('one — 0', { exact: true })).not.toBeVisible();
	assert.ok(await page.evaluate(() => window.privateRevokedUrls.length > 0));
	await section.locator('summary').click();
	await section.getByRole('button', { name: '添付ファイルを表示: private.png', exact: true }).click();
	await expect(section.locator('img[src^="blob:"]')).toBeVisible();
	const loaded = await section.locator('img[src^="blob:"]').getAttribute('src');
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, fixture.grid.token);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(section.locator('article')).toHaveCount(0, { timeout: 30000 });
	assert.ok(await page.evaluate(url => window.privateRevokedUrls.includes(url), loaded));
	console.log('CW protects text/poll/media; revocation removes visible content and blob URLs PASS');

	await consent();
	await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
	await expect(section.locator('article')).toHaveCount(1, { timeout: 30000 });
	// A real response was already displayed; fail only its next reauthorization.
	await page.route('**/api/gridspace/private-notes', async route => {
		if (route.request().postDataJSON().mode === 'validate') await route.abort('failed');
		else await route.continue();
	});
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(section.locator('article')).toHaveCount(0, { timeout: 30000 });
	await expect(section.getByRole('alert')).toBeVisible();
	await page.unroute('**/api/gridspace/private-notes');
	await section.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(section.locator('article')).toHaveCount(1, { timeout: 30000 });
	// Navigate through MkA/KeepAlive rather than replacing the document.
	await page.getByRole('link', { name: 'アカウント連携', exact: true }).click();
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, fixture.grid.token);
	await page.goBack();
	await expect(section.locator('article')).toHaveCount(0, { timeout: 30000 });
	// Returning revalidates retained references instead of restarting consent/history.
	await expect(section.getByRole('alert')).toBeVisible();
	await expect(section.getByRole('button', { name: '再試行', exact: true })).toBeVisible();
	console.log('Failed reauthorization and KeepAlive return do not retain private content PASS');
	await consent();
	await page.goto(`${g.origin}/gridspace/private`, { waitUntil: 'domcontentloaded' });
	await expect(section.getByText('ノートはありません', { exact: false }).or(section.getByRole('button', { name: 'もっと見る', exact: true }))).toBeVisible({ timeout: 30000 });
	let requests = 0;
	const countPrivate = request => { if (/\/api\/gridspace\/private-(grant|notes)$/.test(request.url())) requests++; };
	page.on('request', countPrivate);
	await page.locator('input[type="search"]').fill('unsubmitted draft');
	await page.waitForTimeout(500);
	page.off('request', countPrivate);
	assert.equal(requests, 0, 'Typing an unsubmitted query reloaded unchanged private results');
	console.log('Unchanged parameters do not reset private results on parent rerender PASS');
	assert.deepEqual(errors, []);
	await context.close();
} finally {
	await browser.close();
	for (const { site, admin, id } of roles) await api(site, 'admin/roles/delete', { roleId: id }, admin.token);
}
