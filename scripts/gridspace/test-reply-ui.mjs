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
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const fixture = JSON.parse(readFileSync('.config/gridspace-reply-test-accounts.json', 'utf8'));
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const accounts = {};
for (const [site, user] of [[g, fixture.grid], [r, fixture.resonite]]) {
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	accounts[site.origin] = { ...await api(site, 'i', {}, user.token), token: user.token };
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(({ accounts }) => {
		const account = accounts[location.origin];
		if (account) localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { accounts });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	const form = page.locator('[data-gridspace-reply]');
	async function open(parent = fixture.specified) {
		await page.goto(`${g.origin}/gridspace/private?noteId=${parent.id}`, { waitUntil: 'domcontentloaded' });
		await page.getByRole('button', { name: /連携先の名義で返信/ }).click();
		await expect(form.getByText(`投稿するアカウント: @${fixture.resonite.username}@${new URL(r.origin).host}`, { exact: true })).toBeVisible();
	}
	await open();
	await expect(form.getByText('連携先の名義での返信を許可する', { exact: true })).toBeVisible();
	await expect(form.locator('textarea')).toHaveCount(0);
	await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: '連携先の名義での返信を許可する', exact: true }).click();
	await page.waitForURL(`${r.origin}/oauth/authorize**`);
	const accept = page.getByRole('button', { name: '許可', exact: true });
	await expect(accept.or(page.getByRole('button', { name: '続ける', exact: false }))).toBeVisible();
	if (!await accept.isVisible()) {
		await page.locator(`label[for="account-${fixture.resonite.id}"]`).click();
		await page.getByRole('button', { name: '続ける', exact: false }).click();
	}
	await expect(page.getByText('連携先から、このアカウントの名義で限定公開の返信を投稿する', { exact: true })).toBeVisible();
	await accept.click(); await page.waitForURL(`${g.origin}/settings/gridspace**`);
	await expect(page.getByText('このサーバーから、連携先のアカウント名義で返信できます。', { exact: true })).toBeVisible();
	console.log('Read-only form and actual browser OAuth write consent PASS');

	await open(fixture.local);
	await expect(form.getByText('連合なしの返信になります。', { exact: true })).toBeVisible();
	const text = `Browser reply ${randomUUID()}`;
	await form.getByRole('textbox', { name: 'テキスト', exact: true }).fill(text);
	await form.getByRole('textbox', { name: '内容の注意書き（CW、任意）', exact: true }).fill('Browser reply CW');
	await page.screenshot({ path: '.config/reply-desktop.png', fullPage: true });
	await form.getByRole('button', { name: 'この名義で返信する', exact: true }).click();
	await expect(form.getByText('返信を投稿しました。', { exact: true })).toBeVisible();
	const notes = await api(r, 'users/notes', { userId: fixture.resonite.id, limit: 100 }, fixture.resonite.token);
	assert.equal(notes.filter(note => note.text === text).length, 1);
	assert.equal(notes.find(note => note.text === text).localOnly, true);
	assert.equal(notes.find(note => note.text === text).cw, 'Browser reply CW');
	console.log('Actual old-account text/CW/local-only reply PASS');

	let lost = false;
	await page.route('**/api/gridspace/private-reply', async route => {
		const body = route.request().postDataJSON();
		if (body.action === 'send' && !lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
	});
	await open();
	const uncertain = `Lost reply ${randomUUID()}`;
	await form.locator('textarea').fill(uncertain);
	await form.getByRole('button', { name: 'この名義で返信する', exact: true }).click();
	await expect(form.getByRole('button', { name: '同じ送信を再試行する', exact: true })).toBeEnabled();
	const ids = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('gridspace:reply:')));
	assert.equal(ids.length, 1); assert.match(ids[0][1], /^[0-9a-f-]{36}$/);
	assert.equal(await page.evaluate(text => JSON.stringify(sessionStorage).includes(text), uncertain), false);
	// A hidden tab clears private text but retains only the unresolved operation id.
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
	await expect(form).toHaveCount(0);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: /連携先の名義で返信/ }).click();
	await expect(form.getByRole('button', { name: '送信結果を確認する', exact: true })).toBeEnabled();
	await expect(form.locator('textarea')).toHaveCount(0);
	await form.getByRole('button', { name: '送信結果を確認する', exact: true }).click();
	await expect(form.getByText('返信を投稿しました。', { exact: true })).toBeVisible();
	assert.equal((await api(r, 'users/notes', { userId: fixture.resonite.id, limit: 100 }, fixture.resonite.token)).filter(note => note.text === uncertain).length, 1);
	assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('gridspace:reply:'))), false);
	await page.unroute('**/api/gridspace/private-reply');
	console.log('Lost response, hidden tab, reload and receipt-only recovery without duplicate PASS');
	const unresolved = randomUUID();
	await page.evaluate(({ account, note, requestId }) => sessionStorage.setItem(`gridspace:reply:${account}:${note}`, requestId), { account: fixture.grid.id, note: fixture.specified.id, requestId: unresolved });
	await open();
	await form.getByRole('button', { name: '送信結果を確認する', exact: true }).click();
	await expect(form.getByRole('button', { name: '送信結果を確認する', exact: true })).toBeEnabled();
	await expect(form.locator('textarea')).toHaveCount(0);
	await expect(form.getByRole('button', { name: 'この名義で返信する', exact: true })).toHaveCount(0);
	assert.equal(await page.evaluate(({ account, note }) => sessionStorage.getItem(`gridspace:reply:${account}:${note}`), { account: fixture.grid.id, note: fixture.specified.id }), unresolved);
	await form.getByRole('button', { name: 'この送信の確認をやめる', exact: true }).click();
	await page.getByTestId('modal-dialog-cancel').click();
	await expect(page.getByTestId('modal-dialog-cancel')).toHaveCount(0);
	await expect(form.locator('textarea')).toHaveCount(0);
	await form.getByRole('button', { name: 'この送信の確認をやめる', exact: true }).click();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(form.locator('textarea')).toBeVisible();
	console.log('Missing receipt stays unresolved until explicit discard confirmation PASS');

	await page.setViewportSize({ width: 390, height: 844 });
	await open();
	await form.locator('textarea').fill('Unsent private draft');
	await page.screenshot({ path: '.config/reply-mobile.png', fullPage: true });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await form.getByRole('button', { name: '閉じる', exact: true }).click();
	await page.getByRole('button', { name: /連携先の名義で返信/ }).click();
	await expect(form.locator('textarea')).toHaveValue('');
	assert.deepEqual(errors, []);
	console.log('Mobile layout, labeled fields and discarded unsent draft PASS');
} finally { await browser.close(); }
