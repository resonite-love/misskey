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
		const combined = page.getByRole('button', { name: '両アカウントの投稿を表示', exact: true });
		await expect(combined).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
		await expect(page.getByText('連携しているアカウント', { exact: true })).toBeVisible();
		await expect(page.getByText(`${new URL(site.origin).host}からの投稿`, { exact: true }).first()).toBeVisible({ timeout: 30000 });
		const next = page.getByRole('button', { name: 'もっと見る', exact: true });
		await next.scrollIntoViewIfNeeded();
		await next.click();
		await expect(page.getByText('Historical CW', { exact: true }).first()).toBeVisible({ timeout: 30000 });
		await combined.scrollIntoViewIfNeeded();
		await combined.click();
		await expect(combined).toHaveAttribute('aria-pressed', 'false');
		await expect(page.getByText(`${new URL(site.origin).host}からの投稿`, { exact: true })).toHaveCount(0);
		await combined.focus(); await page.keyboard.press('Enter');
		await expect(combined).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByText(`${new URL(site.origin).host}からの投稿`, { exact: true }).first()).toBeVisible();
		await page.screenshot({ path: `.config/history-${site.role.toLowerCase()}-desktop.png` });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: `.config/history-${site.role.toLowerCase()}-mobile.png` });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		assert.deepEqual(errors, []);
		console.log(`${site.role} linked profile, pagination, account toggle, keyboard and mobile layout PASS`);
		await context.close();
	}
} finally { await browser.close(); }
