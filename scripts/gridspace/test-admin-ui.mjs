/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';

const { chromium, expect } = createRequire(resolve('packages/frontend/package.json'))('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-admin-test-accounts.json', 'utf8'));
for (const site of [g, r]) site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let announcementId;
try {
	async function contextFor(site, user) {
		await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
		const account = { ...await api(site, 'i', {}, user.token), token: user.token };
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(({ origin, account }) => {
			if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
			localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
			localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		}, { origin: site.origin, account });
		return context;
	}
	const context = await contextFor(g, g.accounts.admin);
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${g.origin}/admin/gridspace`);
	await expect(page.getByText('接続できました', { exact: true })).toBeVisible();
	await page.getByRole('textbox', { name: '利用者IDで絞り込み（空欄で全員）' }).fill(fixture.viewer.id);
	await page.getByRole('button', { name: '絞り込みを適用', exact: true }).click();
	await expect(page.getByRole('button', { name: 'この利用者にお知らせ', exact: true })).toHaveCount(1);
	await page.screenshot({ path: '.config/admin-desktop.png', fullPage: true, animations: 'disabled' });
	await page.getByRole('button', { name: 'この利用者にお知らせ', exact: true }).click();
	const title = `連携テストのお知らせ ${Date.now()}`;
	await page.getByRole('textbox', { name: 'タイトル', exact: true }).fill(title);
	await page.getByRole('textbox', { name: 'テキスト', exact: true }).fill('連携の動作確認です。このお知らせはテスト対象の利用者だけに表示します。');
	await page.getByRole('button', { name: '宛先と本文を確認して公開', exact: true }).click();
	await expect(page.getByText(`宛先と本文を確認して公開: @${fixture.viewer.username}`, { exact: true })).toBeVisible();
	const created = page.waitForResponse(response => response.url().endsWith('/api/admin/announcements/create'));
	await page.getByRole('button', { name: 'OK', exact: true }).click();
	const response = await created; assert.equal(response.status(), 200);
	assert.equal(response.request().postDataJSON().userId, fixture.viewer.id);
	announcementId = (await response.json()).id;
	const viewerContext = await contextFor(g, fixture.viewer);
	const viewer = await viewerContext.newPage();
	await viewer.goto(`${g.origin}/announcements/${announcementId}`);
	await expect(viewer.getByText(title, { exact: true }).first()).toBeVisible();
	const outsider = await api(g, 'announcements', { limit: 100 }, g.accounts.reader.token);
	assert.ok(!outsider.some(item => item.id === announcementId));
	console.log('Admin recipient confirmation and actual user-only announcement delivery PASS');
	await page.reload();
	await expect(page.getByText('接続できました', { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	await page.screenshot({ path: '.config/admin-mobile.png', fullPage: true, animations: 'disabled' });
	const rContext = await contextFor(r, r.accounts.admin); const rPage = await rContext.newPage();
	await rPage.goto(`${r.origin}/admin/gridspace`);
	await expect(rPage.getByText('接続できました', { exact: true })).toBeVisible();
	console.log('G/R control panel and mobile layout PASS');

	await page.route('**/api/admin/gridspace/links', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) }));
	let releaseJobs;
	const held = new Promise(resolveWait => { releaseJobs = resolveWait; });
	await page.route('**/api/admin/gridspace/jobs', async route => { await held; await route.continue(); });
	await page.getByRole('button', { name: 'リロード', exact: true }).first().click();
	await expect(page.getByRole('button', { name: '絞り込みを適用', exact: true })).toBeDisabled();
	releaseJobs();
	await expect(page.getByRole('button', { name: '絞り込みを適用', exact: true })).toBeEnabled();
	await expect(page.getByRole('alert')).toContainText('表示済みの情報は古い可能性');
	await page.waitForResponse(response => response.url().endsWith('/api/admin/gridspace/status'), { timeout: 45000 });
	await expect(page.getByRole('alert')).toContainText('表示済みの情報は古い可能性');
	await page.unroute('**/api/admin/gridspace/links'); await page.unroute('**/api/admin/gridspace/jobs');
	await page.getByRole('button', { name: '絞り込みを適用', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	assert.deepEqual(errors, []);
	console.log('Partial failure keeps controls serialized and stale-data warning survives summary refresh PASS');
} finally {
	if (announcementId) await api(g, 'admin/announcements/delete', { id: announcementId }, g.accounts.admin.token);
	await browser.close();
}
