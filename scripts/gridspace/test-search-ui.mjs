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
const accounts = JSON.parse(readFileSync('.config/gridspace-search-test-accounts.json', 'utf8'));
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	for (const [site, user] of [[loadSite('.', 0), accounts.viewer], [loadSite('../resonite-love-gridspace', 1), accounts.resonite]]) {
		await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
		const account = { ...await api(site, 'i', {}, user.token), token: user.token };
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(({ account }) => {
			localStorage.setItem('account', JSON.stringify(account));
			localStorage.setItem('lang', 'ja-JP');
			localStorage.setItem('neverShowDonationInfo', 'true');
			localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		}, { account });
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		const requests = [];
		page.on('request', request => { if (request.url().endsWith('/api/gridspace/search')) requests.push(request.postDataJSON()); });
		await page.goto(`${site.origin}/search`, { waitUntil: 'domcontentloaded' });
		await expect(page.locator('#splash')).toHaveCount(0, { timeout: 30000 });
		await expect(page.getByText('両サーバー', { exact: true })).toBeVisible();
		await page.locator('input[type="search"]').fill(accounts.query);
		await page.getByRole('button', { name: '検索', exact: true }).click();
		await expect(page.locator('article')).toHaveCount(10, { timeout: 30000 });
		const next = page.getByRole('button', { name: 'もっと見る', exact: true });
		await next.scrollIntoViewIfNeeded(); await next.click();
		await expect.poll(() => page.locator('article').count()).toBeGreaterThan(10);
		assert.ok(requests.length >= 2 && requests[1].cursor);
		const peerHost = site.role === 'G' ? 'resonite-love-misskey.kokopi.me' : 'grid-space-misskey.kokopi.me';
		await expect(page.locator(`article header a[href*="@${peerHost}"]`).first()).toBeVisible();
		await page.getByText('検索結果', { exact: true }).scrollIntoViewIfNeeded();
		await page.screenshot({ path: `.config/search-${site.role.toLowerCase()}-desktop.png` });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: `.config/search-${site.role.toLowerCase()}-mobile.png` });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		await page.goto(`${site.origin}/search?type=user`, { waitUntil: 'domcontentloaded' });
		await page.locator('input[type="search"]').fill(accounts.grid.username);
		await page.getByRole('button', { name: '検索', exact: true }).click();
		await expect(page.getByText('連携しているアカウント', { exact: true })).toBeVisible({ timeout: 30000 });
		await expect(page.locator(`a[href*="${accounts.resonite.username}"]`).first()).toBeVisible();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		if (site.role === 'G') {
			// Exercise preview replacement using a partial response; the actual stopped-peer
			// transport and unchanged cursor are covered by test-search-outage.mjs.
			let partial = true;
			await page.route('**/api/gridspace/search', async route => {
				if (!partial) { await route.continue(); return; }
				partial = false;
				const response = await route.fetch();
				const body = await response.json();
				await route.fulfill({ response, json: { ...body, notes: body.notes.filter(note => note.user.host == null), peerAvailable: false, cursor: null } });
			});
			await page.goto(`${site.origin}/search`, { waitUntil: 'domcontentloaded' });
			await page.locator('input[type="search"]').fill(accounts.query);
			await page.getByRole('button', { name: '検索', exact: true }).click();
			await expect(page.getByText('相手サーバーの結果を取得できませんでした。取得できた結果を表示しています。再試行すると続きを取得します。', { exact: true })).toBeVisible();
			await page.mouse.move(0, 0);
			await page.getByRole('button', { name: '再試行', exact: true }).focus();
			await page.keyboard.press('Enter');
			await expect(page.locator('article')).toHaveCount(10);
			await expect(page.locator(`article header a[href*="@${peerHost}"]`).first()).toBeVisible();
			console.log('G partial response preview is replaced on retry without duplicate rows PASS');
		}
		assert.deepEqual(errors, []);
		console.log(`${site.role} real search UI: default community, both origins, pagination, linked people and mobile layout PASS`);
		await context.close();
	}
} finally { await browser.close(); }
