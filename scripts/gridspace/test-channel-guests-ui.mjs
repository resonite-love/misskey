/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const fixture = JSON.parse(readFileSync('.config/gridspace-channels-test-accounts.json', 'utf8'));
const { guest } = JSON.parse(readFileSync('.config/gridspace-channel-guest.json', 'utf8'));
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, guest.token);
const account = { ...await api(g, 'i', {}, guest.token), token: guest.token };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ origin, account }) => {
		if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { origin: g.origin, account });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${g.origin}/channels`);
	await page.locator(`[data-combined-channels] a[href="/gridspace/channels/${fixture.channel.id}"]`).click();
	const root = page.locator('[data-gridspace-channels]');
	await expect(root.getByText(`Channel body ${fixture.suffix}`, { exact: true })).toBeVisible();
	await root.getByRole('button', { name: 'このチャンネルに投稿する', exact: true }).click();
	const composer = root.locator('[data-gridspace-reply]');
	await expect(composer.getByText(`投稿するアカウント: @${guest.username}@${new URL(g.origin).host}`, { exact: true })).toBeVisible();
	const text = `Guest browser ${randomUUID()}`;
	await composer.getByRole('textbox', { name: 'テキスト', exact: true }).fill(text);
	await composer.getByRole('button', { name: 'この名義で投稿する', exact: true }).click();
	await expect(composer.getByText('チャンネルに投稿しました。', { exact: true })).toBeVisible();
	await composer.getByRole('button', { name: '閉じる', exact: true }).click();
	const note = root.locator('[data-gridspace-private-note]').filter({ hasText: text });
	await expect(note).toBeVisible();
	await expect(note.getByText(`@${guest.username}@${new URL(g.origin).host}`, { exact: true })).toBeVisible();
	await page.screenshot({ path: '.config/channel-guest-desktop.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/channel-guest-mobile.png', fullPage: true });
	assert.equal(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
	await note.getByRole('button', { name: '削除', exact: true }).click();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(note).toHaveCount(0);
	assert.ok(!(await api(r, 'channels/timeline', { channelId: fixture.channel.id, limit: 100 }, fixture.resonite.token)).some(item => item.text === text));
	assert.equal((await api(g, 'gridspace/link', {}, guest.token)).state, 'unlinked');
	console.log('No-OAuth channel entry, G identity, desktop/mobile and own-note deletion UI PASS');
	assert.deepEqual(errors, []);
} finally { await browser.close(); }
