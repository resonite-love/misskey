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
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, fixture.grid.token);
const account = { ...await api(g, 'i', {}, fixture.grid.token), token: fixture.grid.token };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const adminToken = JSON.parse(readFileSync(g.accountsPath, 'utf8')).accounts.admin.token;
const createdChannels = [];
let roleId;
try {
	const role = await api(g, 'admin/roles/create', { name: `Channel UI ${fixture.suffix}`, description: 'Temporary UI test role', color: null, iconUrl: null, target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } } }, adminToken);
	roleId = role.id;
	await api(g, 'admin/roles/assign', { roleId, userId: fixture.grid.id }, adminToken);
	const stalePages = await api(g, 'channels/search', { query: `Pagination ${fixture.suffix}-`, limit: 100 }, fixture.grid.token);
	for (const channel of stalePages) if (channel.userId === fixture.grid.id) await api(g, 'channels/update', { channelId: channel.id, isArchived: true }, fixture.grid.token);
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ origin, account }) => {
		if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { origin: g.origin, account });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	const url = `${g.origin}/gridspace/channels/${fixture.channel.id}`;
	await page.goto(`${g.origin}/channels`);
	const combined = page.locator('[data-combined-channels]');
	await expect(combined.locator(`a[href="/channels/${fixture.gridChannel.id}"]`)).toBeVisible();
	await expect(combined.locator(`a[href="/gridspace/channels/${fixture.channel.id}"]`)).toBeVisible();
	await expect(page.getByRole('link', { name: '連携先のチャンネル', exact: true })).toHaveCount(0);
	await page.screenshot({ path: '.config/channels-combined-desktop.png', fullPage: true });
	await page.getByRole('button', { name: /お気に入り/ }).click();
	await expect(combined.locator(`a[href="/channels/${fixture.gridChannel.id}"]`)).toBeVisible();
	await expect(combined.locator(`a[href="/gridspace/channels/${fixture.channel.id}"]`)).toBeVisible();
	await page.getByRole('button', { name: /検索/ }).click();
	await page.getByRole('searchbox').fill(fixture.suffix);
	await page.getByRole('searchbox').press('Enter');
	await expect(combined.locator(`a[href="/channels/${fixture.gridChannel.id}"]`)).toBeVisible();
	await expect(combined.locator(`a[href="/gridspace/channels/${fixture.channel.id}"]`)).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(combined.getByText(new URL(r.origin).host, { exact: true }).first()).toBeVisible();
	await page.screenshot({ path: '.config/channels-combined-mobile.png', fullPage: true });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
	await page.setViewportSize({ width: 1280, height: 960 });
	for (let index = 0; index < 12; index++) createdChannels.push(await api(g, 'channels/create', { name: `Pagination ${fixture.suffix}-${index}` }, fixture.grid.token));
	await page.route('**/api/gridspace/channels', route => route.abort());
	await page.getByRole('searchbox').press('Enter');
	await expect(combined.getByText('チャンネルを取得できませんでした。連携の権限と接続状況を確認してください。')).toBeVisible();
	await combined.getByRole('button', { name: 'もっと見る', exact: true }).click();
	await expect(combined.locator(`a[href="/channels/${fixture.gridChannel.id}"]`)).toBeVisible();
	await page.unroute('**/api/gridspace/channels');
	await combined.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(combined.locator(`a[href="/gridspace/channels/${fixture.channel.id}"]`)).toBeVisible();
	await combined.locator(`a[href="/gridspace/channels/${fixture.channel.id}"]`).click();
	const root = page.locator('[data-gridspace-channels]');
	await expect(page).toHaveURL(url);
	await expect(root.getByText(`Channel body ${fixture.suffix}`, { exact: true })).toBeVisible();
	assert.ok(await page.evaluate(key => Number(localStorage.getItem(key)) > 0, `channelLastReadedAt:${r.origin}:${fixture.channel.id}`));
	await expect(root.getByRole('heading', { name: '連携先の権限で読む投稿' })).toHaveCount(0);
	await page.goto(`${g.origin}/channels`);
	const readCard = combined.locator(`a[href="/gridspace/channels/${fixture.channel.id}"]`);
	await expect(readCard).toBeVisible();
	await expect(readCard.locator('..').locator('.indicator')).toHaveCount(0);
	await readCard.click();
	await expect(root.getByText(`Channel body ${fixture.suffix}`, { exact: true })).toBeVisible();
	console.log('Normal channels entry, search, channel navigation and plain timeline PASS');

	let offline = true;
	await page.route('**/api/gridspace/private-notes', route => offline ? route.abort() : route.continue());
	await root.getByRole('button', { name: 'リロード', exact: true }).click();
	const unavailable = root.getByText('チャンネルの投稿を取得できませんでした。接続と閲覧の許可を確認して再試行してください。', { exact: true });
	await expect(unavailable).toBeVisible();
	await expect(root.locator('[data-gridspace-private-note]')).toHaveCount(0);
	offline = false;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(root.getByText(`Channel body ${fixture.suffix}`, { exact: true })).toBeVisible();
	await expect(unavailable).toHaveCount(0);
	offline = true;
	await root.getByRole('button', { name: 'リロード', exact: true }).click();
	await expect(unavailable).toBeVisible();
	offline = false;
	await expect(root.getByText(`Channel body ${fixture.suffix}`, { exact: true })).toBeVisible({ timeout: 50000 });
	await page.unroute('**/api/gridspace/private-notes');
	console.log('Transient channel read failure clears content and recovers on focus and with backoff without manual reload PASS');

	await root.getByRole('button', { name: 'このチャンネルに投稿する', exact: true }).click();
	const composer = root.locator('[data-gridspace-reply]');
	await expect(composer.getByText(`投稿するアカウント: @${fixture.resonite.username}@${new URL(r.origin).host}`, { exact: true })).toBeVisible();
	const body = `UI channel ${randomUUID()}`;
	await composer.getByRole('textbox', { name: '内容の注意書き（CW、任意）', exact: true }).fill('UI channel CW');
	await composer.getByRole('textbox', { name: 'テキスト', exact: true }).fill(body);
	// Use the known-good image already used by the two-server fixture.
	const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNw2BL1nxLMMGrA/9EwiBoNgy3DIgwAwJVNH4qw1v8AAAAASUVORK5CYII=', 'base64');
	await composer.locator('input[type=file]').setInputFiles({ name: 'ui-channel.png', mimeType: 'image/png', buffer: image });
	await composer.getByRole('button', { name: 'この名義で投稿する', exact: true }).click();
	await expect(composer.getByText('チャンネルに投稿しました。', { exact: true })).toBeVisible();
	await composer.getByRole('button', { name: '閉じる', exact: true }).click();
	const posted = root.locator('[data-gridspace-private-note]').filter({ hasText: 'UI channel CW' });
	await posted.locator('summary').click(); await expect(posted.getByText(body, { exact: true })).toBeVisible();
	await posted.getByRole('button', { name: /添付ファイルを表示/ }).click();
	await expect(posted.locator('img[alt="ui-channel.png"]')).toBeVisible();
	await page.screenshot({ path: '.config/channels-desktop.png', fullPage: true });
	console.log('Old identity, CW, attachment upload and authenticated image display UI PASS');

	const fresh = `Live channel ${randomUUID()}`;
	await api(r, 'notes/create', { channelId: fixture.channel.id, text: fresh }, fixture.author.token);
	await expect(root.getByText(fresh, { exact: true })).toBeVisible({ timeout: 40000 });
	console.log('New source post appears without navigation PASS');

	await root.getByRole('button', { name: 'このチャンネルに投稿する', exact: true }).click();
	const uncertain = `Lost response ${randomUUID()}`;
	await composer.getByRole('textbox', { name: 'テキスト', exact: true }).fill(uncertain);
	let dropped = false;
	await page.route('**/api/gridspace/channel-post', async route => {
		if (!dropped && route.request().postDataJSON().action === 'send') {
			dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort();
		} else await route.continue();
	});
	await composer.getByRole('button', { name: 'この名義で投稿する', exact: true }).click();
	await expect(composer.getByText('送信結果を確認できませんでした。再試行すると同じ送信を確認します。二重には投稿しません。', { exact: true })).toBeVisible();
	await composer.getByRole('button', { name: '同じ送信を再試行する', exact: true }).click();
	await expect(composer.getByText('チャンネルに投稿しました。', { exact: true })).toBeVisible();
	await composer.getByRole('button', { name: '閉じる', exact: true }).click();
	const source = await api(r, 'channels/timeline', { channelId: fixture.channel.id, limit: 100 }, fixture.resonite.token);
	assert.equal(source.filter(note => note.text === uncertain).length, 1);
	await page.unroute('**/api/gridspace/channel-post');
	console.log('Committed post with lost HTTP response retries without duplicate PASS');

	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/channels-mobile.png', fullPage: true });
	assert.equal(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
	await page.goto(`${g.origin}/gridspace/channels/${fixture.sensitive.id}`);
	await expect(root.getByRole('button', { name: 'センシティブなチャンネルの投稿を表示する', exact: true })).toBeVisible();
	await expect(root.locator('[data-gridspace-private-note]')).toHaveCount(0);
	await root.getByRole('button', { name: 'センシティブなチャンネルの投稿を表示する', exact: true }).click();
	await expect(root.getByText(`Sensitive body ${fixture.suffix}`, { exact: true })).toBeVisible();
	await page.goto(url);
	await expect(root.getByText(uncertain, { exact: true })).toBeVisible();
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, fixture.grid.token);
	await expect(root.locator('[data-gridspace-private-note]')).toHaveCount(0, { timeout: 40000 });
	await expect(root.getByText('チャンネルの投稿を取得できませんでした。接続と閲覧の許可を確認して再試行してください。', { exact: true })).toBeVisible();
	console.log('Mobile width, sensitive reveal and live revocation clear PASS');
	assert.deepEqual(errors, []);
} finally {
	await browser.close();
	for (const channel of createdChannels) await api(g, 'channels/update', { channelId: channel.id, isArchived: true }, fixture.grid.token).catch(() => {});
	if (roleId) await api(g, 'admin/roles/delete', { roleId }, adminToken);
}
