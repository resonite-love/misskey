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
const g = loadSite('.', 0);
const fixture = JSON.parse(readFileSync('.config/gridspace-notification-test-accounts.json', 'utf8'));
await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, fixture.grid.token);
const account = { ...await api(g, 'i', {}, fixture.grid.token), token: fixture.grid.token };
assert.equal((await api(g, 'gridspace/private-grant', {}, fixture.grid.token)).canReadNotifications, true);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ account, origin }) => {
		if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { account, origin: g.origin });
	const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = []; const legacyRequests = [];
	page.on('pageerror', e => errors.push(e.message));
	page.on('request', request => { if (/\/api\/i\/notifications(?:-grouped)?$/.test(request.url())) legacyRequests.push(request.url()); });
	// Read flags are not relevant to loading and must not change our fixture.
	await page.route('**/api/gridspace/notifications/read', route => route.abort());
	let releaseCount; let countPending = false; const limits = [];
	const blockedCount = new Promise(resolve => { releaseCount = resolve; });
	await page.route('**/api/gridspace/notifications', async route => {
		const params = route.request().postDataJSON();
		if (params.countOnly) { countPending = true; await blockedCount; }
		else if (!params.ids) limits.push(params.limit);
		await route.continue();
	});
	await page.goto(`${g.origin}/my/notifications`, { waitUntil: 'domcontentloaded' });
	const rows = page.locator('[data-notification-key]');
	await expect(rows.first()).toBeVisible({ timeout: 10000 });
	assert.equal(countPending, true);
	assert.ok(limits.length >= 2 && limits.every(limit => limit === 20));
	assert.deepEqual(legacyRequests, []);
	releaseCount();
	console.log('First notification page renders while badge count is still pending; 20-row requests PASS');
	await page.unroute('**/api/gridspace/notifications');
	const firstKey = await rows.first().getAttribute('data-notification-key');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(rows.first()).toBeVisible();
	assert.equal(await rows.first().getAttribute('data-notification-key'), firstKey);
	assert.equal((await rows.allTextContents()).some(text => text.includes('live notification')), true);
	await page.screenshot({ path: '.config/notification-loading17.png' });
	console.log('Browser reload restores ordered local/peer notifications and protected mention PASS');
	await page.route('**/api/gridspace/notifications', route => route.request().postDataJSON().source === 'peer' ? route.abort() : route.continue());
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.getByRole('status').filter({ hasText: '一部の通知を取得できません' }).first()).toBeVisible();
	await expect(rows.first()).toBeVisible();
	assert.equal(await page.locator('[data-gridspace-private-note]').count(), 0);
	await page.unroute('**/api/gridspace/notifications');
	await page.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(page.locator('[data-gridspace-private-note]').first()).toBeVisible();
	console.log('Peer outage retains local rows; retry restores authorized peer content PASS');
	assert.deepEqual(errors, []);
} finally { await browser.close(); }
