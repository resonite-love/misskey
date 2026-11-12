/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount, seedProfile } from './test-profile-import.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g); const old = await makeProfileAccount(r);
const original = await seedProfile(r, old);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ grid, old, gOrigin, rOrigin }) => {
		if (![gOrigin, rOrigin].includes(location.origin) || localStorage.getItem('profile18-seeded')) return;
		localStorage.setItem('account', JSON.stringify(location.origin === gOrigin ? grid : old));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true'); localStorage.setItem('profile18-seeded', 'true');
	}, { grid, old, gOrigin: g.origin, rOrigin: r.origin });
	const page = await context.newPage(); page.setDefaultTimeout(20000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	let copies = 0; let failAccountRefresh = false;
	await page.route(`${g.origin}/api/i`, route => failAccountRefresh ? route.abort() : route.continue());
	await page.route(`${g.origin}/api/gridspace/profile-import`, async route => {
		copies++;
		if (copies === 1) { const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort(); }
		else await route.continue();
	});
	await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: '連携して設定を引き継ぐ', exact: true }).click();
	await page.waitForURL(`${r.origin}/oauth/authorize**`);
	const accept = page.getByRole('button', { name: '許可', exact: true });
	const next = page.getByRole('button', { name: '続ける', exact: false });
	await expect(accept.or(next)).toBeVisible();
	if (!await accept.isVisible()) { await page.locator(`label[for="account-${old.id}"]`).click(); await next.click(); }
	await accept.click();
	await page.waitForURL(`${g.origin}/settings/gridspace**`);
	await expect(page.getByRole('alert').filter({ hasText: 'プロフィールの一部を引き継げませんでした' })).toBeVisible();
	const copied = await api(g, 'i', {}, grid.token);
	assert.equal(copied.name, original.name); assert.equal(copied.description, original.description);
	assert.ok(copied.avatarId && copied.bannerId);
	console.log('OAuth callback automatically imports profile and images; lost response is retryable PASS');
	await api(g, 'i/update', { description: 'Edited on GridSpace' }, grid.token);
	failAccountRefresh = true;
	await page.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'プロフィールの引き継ぎが完了しました' })).toBeVisible();
	await expect(page.getByRole('alert').filter({ hasText: 'プロフィールの一部を引き継げませんでした' })).toHaveCount(0);
	assert.equal((await api(g, 'i', {}, grid.token)).description, 'Edited on GridSpace');
	failAccountRefresh = false;
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.getByRole('button', { name: '空欄のプロフィールを引き継ぐ', exact: true })).toBeVisible();
	assert.equal(copies, 2);
	await page.getByRole('button', { name: '空欄のプロフィールを引き継ぐ', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'プロフィールの引き継ぎが完了しました' })).toBeVisible();
	assert.equal((await api(g, 'i', {}, grid.token)).description, 'Edited on GridSpace');
	await page.screenshot({ path: '.config/profile18-desktop.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: '.config/profile18-mobile.png', fullPage: true });
	assert.deepEqual(errors, []);
	console.log('Retry preserves edits, failed account refresh does not report copy failure, existing-user button and mobile UI PASS');
} finally { await browser.close(); }
