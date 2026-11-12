/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite } from './lab.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
async function account(site) {
	const admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
	const user = await api(site, 'admin/accounts/create', { username: `palette_${randomBytes(5).toString('hex')}`, password: randomBytes(24).toString('base64url') }, admin.token);
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	return { ...await api(site, 'i', {}, user.token), token: user.token };
}
const destination = await account(g); const active = await account(r); const selected = await account(r);
const palettes = [{ id: 'selected-main', name: 'B のパレット', emojis: ['😀', ':resonite:'] }, { id: 'selected-reaction', name: 'B のリアクション', emojis: ['👍', ':remote@example.net:'] }];
const other = [{ id: 'active-only', name: 'A only', emojis: ['😺'] }];
const rHost = new URL(r.origin).host;
for (const [user, values] of [[active, other], [selected, palettes]]) {
	for (const [key, scope, value] of [['emojiPalettes', { server: rHost }, values], ['emojiPaletteForMain', { server: rHost }, values[0].id], ['emojiPaletteForReaction', { server: rHost }, values.at(-1).id]]) {
		await api(r, 'i/registry/set', { scope: ['client', 'preferences', 'sync'], key: `default:${key}`, value: [[scope, value]] }, user.token);
	}
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ destination, active, selected, gOrigin, rOrigin, rHost, other }) => {
		if (![gOrigin, rOrigin].includes(location.origin) || localStorage.getItem('palette-ui-seeded')) return;
		const source = location.origin === rOrigin;
		localStorage.setItem('account', JSON.stringify(source ? active : destination));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		const preferences = source ? {
			accounts: [[{}, [[rHost, { id: selected.id, username: selected.username }]], {}]],
			emojiPalettes: [[{ server: rHost }, other, { sync: true }]],
			emojiPaletteForMain: [[{ server: rHost }, 'active-only', { sync: true }]],
			emojiPaletteForReaction: [[{ server: rHost }, 'active-only', { sync: true }]],
		} : { emojiPalettes: [[{ server: location.host }, [{ id: 'destination', name: 'ぐりすぺ', emojis: ['🎉'] }], {}]] };
		localStorage.setItem('preferences', JSON.stringify({ id: 'palette-ui', type: 'main', version: '1', modifiedAt: Date.now(), name: 'test', preferences }));
		if (source) localStorage.setItem('pizzax::base', JSON.stringify({ accountTokens: { [`${rHost}/${selected.id}`]: selected.token }, accountInfos: { [`${rHost}/${selected.id}`]: selected } }));
		localStorage.setItem('palette-ui-seeded', 'true');
	}, { destination, active, selected, gOrigin: g.origin, rOrigin: r.origin, rHost, other });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	let failPalette = true; let paletteRequests = 0; const snapshots = [];
	await page.route(`${g.origin}/api/gridspace/palette`, async route => {
		paletteRequests++;
		if (failPalette) await route.abort('failed'); else await route.continue();
	});
	page.on('request', request => {
		if (request.url() === `${r.origin}/oauth/decision`) snapshots.push(JSON.parse(new URLSearchParams(request.postData()).get('gridspace_palette')));
	});
	async function consent() {
		await page.waitForURL(`${r.origin}/oauth/authorize**`);
		await page.locator(`label[for="account-${selected.id}"]`).click();
		await page.getByRole('button', { name: '続ける', exact: false }).click();
		await page.getByRole('button', { name: '許可', exact: true }).click();
		await page.waitForURL(`${g.origin}/settings/gridspace**`);
	}
	async function preference(key) {
		return page.evaluate(({ key, userId }) => {
			const rows = JSON.parse(localStorage.getItem('preferences')).preferences[key];
			return (rows.find(([scope]) => scope.account === userId) ?? rows.find(([scope]) => scope.account == null))[1];
		}, { key, userId: destination.id });
	}
	await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: '連携して設定を引き継ぐ', exact: true }).click();
	await consent();
	await expect(page.getByText('アカウント連携は完了しましたが、絵文字パレットを引き継げませんでした。再試行してください。', { exact: true })).toBeVisible();
	assert.equal(await preference('gridspacePaletteImportPending'), true);
	assert.deepEqual(snapshots[0].palettes, palettes);
	assert.equal(snapshots[0].forMain, 'selected-main');
	assert.equal(snapshots[0].forReaction, 'selected-reaction');
	assert.equal((await api(g, 'gridspace/link', {}, destination.token)).peerUserId, selected.id);
	console.log('Actual OAuth account B exports B cloud palettes while account A is logged in PASS');
	failPalette = false;
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.getByText('絵文字パレットを引き継ぎました。', { exact: true })).toBeVisible();
	assert.equal(await preference('gridspacePaletteImportPending'), false);
	const imported = await preference('emojiPalettes');
	assert.equal(imported[0].id, 'destination');
	assert.deepEqual(imported.slice(1).map(({ name, emojis }) => ({ name, emojis })), palettes.map(({ name, emojis }) => ({ name, emojis })));
	assert.equal(await preference('emojiPaletteForMain'), imported[1].id);
	assert.equal(await preference('emojiPaletteForReaction'), imported[2].id);
	assert.equal(paletteRequests, 2);
	console.log('Failed palette fetch resumes after reload without OAuth; destination palettes and selections preserved PASS');
	await page.evaluate(userId => {
		const profile = JSON.parse(localStorage.getItem('preferences'));
		profile.preferences.emojiPalettes.find(([scope]) => scope.account === userId)[1][1].emojis = ['🛠️'];
		localStorage.setItem('preferences', JSON.stringify(profile));
	}, destination.id);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: '連携の権限をまとめて更新', exact: true }).click();
	await consent();
	await expect(page.getByText('限定投稿の閲覧・検索、通知、連携先のアカウント名義での返信・リアクション・投票・添付を利用できます。', { exact: true })).toBeVisible();
	assert.equal(paletteRequests, 2);
	assert.deepEqual((await preference('emojiPalettes'))[1].emojis, ['🛠️']);
	await page.screenshot({ path: '.config/palette-desktop.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/palette-mobile.png', fullPage: true });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	assert.deepEqual(errors, []);
	console.log('Reauthorization does not duplicate palettes or replace edits; desktop/mobile render without errors PASS');
	await context.close();
} finally { await browser.close(); }
