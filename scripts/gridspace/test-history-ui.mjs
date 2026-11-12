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
const accounts = JSON.parse(readFileSync('.config/gridspace-history-test-accounts.json', 'utf8'));
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	for (const [site, user, profile] of [[loadSite('.', 0), accounts.viewer, accounts.grid], [loadSite('../resonite-love-gridspace', 1), accounts.resonite, accounts.resonite]]) {
		await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
		const account = { ...await api(site, 'i', {}, user.token), token: user.token };
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(({ account }) => {
			localStorage.setItem('account', JSON.stringify(account));
			localStorage.setItem('lang', 'ja-JP');
			localStorage.setItem('neverShowDonationInfo', 'true');
			localStorage.setItem('preferences', JSON.stringify({ id: 'history-ui-test', type: 'main', version: '1', modifiedAt: Date.now(), name: 'history-test', preferences: { enableInfiniteScroll: [[{}, false, {}]] } }));
		}, { account });
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`${site.origin}/@${profile.username}/notes`, { waitUntil: 'domcontentloaded' });
		await expect(page.getByText('連携しているアカウント', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: '両アカウントの投稿を表示', exact: true })).toHaveCount(0);
		const peerHost = site.role === 'G' ? 'resonite-love-misskey.kokopi.me' : 'grid-space-misskey.kokopi.me';
		const peerAccount = site.role === 'G' ? accounts.resonite : accounts.grid;
		await expect(page.locator(`article header a[href="/@${profile.username}"]`).first()).toBeVisible({ timeout: 30000 });
		await expect(page.locator(`article header a[href="/@${peerAccount.username}@${peerHost}"]`).first()).toBeVisible({ timeout: 30000 });
		await expect(page.locator('article').getByText(site.role === 'G' ? 'resonite.love (test)' : 'GridSpace (test)', { exact: true }).first()).toBeVisible();
		await expect(page.getByText(`${new URL(site.origin).host}からの投稿`, { exact: true })).toHaveCount(0);
		await expect(page.getByText(`${peerHost}からの投稿`, { exact: true })).toHaveCount(0);
		const next = page.getByRole('button', { name: 'もっと見る', exact: true });
		await next.scrollIntoViewIfNeeded();
		await next.click();
		await expect(page.getByText('Historical CW', { exact: true }).first()).toBeVisible({ timeout: 30000 });
		await page.getByText('連携しているアカウント', { exact: true }).scrollIntoViewIfNeeded();
		await page.screenshot({ path: `.config/history-${site.role.toLowerCase()}-desktop.png` });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: `.config/history-${site.role.toLowerCase()}-mobile.png` });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		assert.deepEqual(errors, []);
		console.log(`${site.role} linked profile, combined history by default, no opt-out, pagination and mobile layout PASS`);
		await context.close();
	}
} finally { await browser.close(); }
