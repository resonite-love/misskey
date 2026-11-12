/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite, eventually } from './lab.mjs';
const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-notification-test-accounts.json', 'utf8'));
const admin = JSON.parse(readFileSync(r.accountsPath, 'utf8')).accounts.admin.token;
const applicant = await api(r, 'admin/accounts/create', { username: `ui_${randomBytes(5).toString('hex')}`, password: randomBytes(24).toString('hex') }, admin);
await api(r, 'i/update', { isLocked: true }, fixture.old.token);
await api(r, 'following/create', { userId: fixture.old.id }, applicant.token);
const account = { ...await api(g, 'i', {}, fixture.grid.token), token: fixture.grid.token };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ account, origin }) => {
		if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { account, origin: g.origin });
	const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.goto(`${g.origin}/my/notifications`, { waitUntil: 'domcontentloaded' });
	const card = page.locator('[data-gridspace-notification-card]').filter({ hasText: applicant.username });
	await expect(card.getByRole('button', { name: /許可$/ })).toBeVisible();
	await expect(card.locator('img').first()).toBeVisible();
	await page.route('**/api/gridspace/notifications/follow-request', route => route.abort());
	await card.getByRole('button', { name: /許可$/ }).click();
	await expect(card.getByRole('alert')).toContainText('フォロー申請を処理できませんでした');
	await expect(card.getByRole('button', { name: /許可$/ })).toBeEnabled();
	await page.screenshot({ path: '.config/notification-card-retry-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: '.config/notification-card-retry-mobile.png' });
	await page.unroute('**/api/gridspace/notifications/follow-request');
	await card.getByRole('button', { name: /許可$/ }).click();
	await eventually('source local follow accepted from peer card', async () => (await api(r, 'users/show', { userId: fixture.old.id }, applicant.token)).isFollowing);
	await expect(card.getByRole('button', { name: /許可$/ })).toHaveCount(0);
	assert.deepEqual(errors, []);
	console.log('Shared notification card avatar, desktop/mobile layout, failed action retry and real source follow approval PASS');
} finally { await browser.close(); }


