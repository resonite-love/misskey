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
		const profile = JSON.parse(localStorage.getItem('preferences') ?? 'null') ?? { id: 'channel-ui-test', version: '2026.11.0', type: 'main', modifiedAt: Date.now(), name: '', preferences: {} };
		profile.preferences.showFixedPostFormInChannel = [[{}, true, {}]];
		localStorage.setItem('preferences', JSON.stringify(profile));
	}, { origin: g.origin, account });
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${g.origin}/channels`);
	await page.locator(`[data-combined-channels] a[href="/gridspace/channels/${fixture.channel.id}"]`).click();
	const root = page.locator('[data-gridspace-channels]');
	await expect(root.getByText(`Channel body ${fixture.suffix}`, { exact: true })).toBeVisible();
	const fixedForm = root.locator('[data-gridspace-post-form]');
	const draft = `Private draft ${randomUUID()}`;
	await fixedForm.getByTestId('post-form-text').fill(draft);
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
	await expect(fixedForm.getByTestId('post-form-text')).toBeHidden();
	await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
	await expect(fixedForm.getByTestId('post-form-text')).toHaveValue(draft);
	assert.equal(await page.evaluate(value => JSON.stringify([localStorage, sessionStorage]).includes(value), draft), false);
	await fixedForm.getByTestId('post-form-text').fill('');
	console.log('Fixed composer keeps an unsent draft in memory across hide/revalidation, without persistent storage PASS');
	await page.getByRole('button', { name: /チャンネルに投稿/ }).click();
	const composer = page.locator('[data-gridspace-post-form]._popup');
	await expect(composer.getByText(`@${guest.username}@${new URL(g.origin).host}`, { exact: true })).toBeVisible();
	// Selecting a local G account must not become a bare mention of a different R account.
	const qualifiedMention = `@${fixture.grid.username}@${new URL(g.origin).host} `;
	await composer.getByRole('textbox', { name: 'テキスト', exact: true }).fill(`@${fixture.grid.username}`);
	await page.locator('ol li').filter({ hasText: `@${fixture.grid.username}` }).first().click();
	await expect(composer.getByRole('textbox', { name: 'テキスト', exact: true })).toHaveValue(qualifiedMention);
	await composer.getByRole('button', { name: '内容を隠す', exact: true }).click();
	await composer.getByRole('textbox', { name: '注釈', exact: true }).fill(`@${fixture.grid.username}`);
	await page.locator('ol li').filter({ hasText: `@${fixture.grid.username}` }).first().click();
	await expect(composer.getByRole('textbox', { name: '注釈', exact: true })).toHaveValue(qualifiedMention);
	await composer.getByRole('textbox', { name: '注釈', exact: true }).fill('');
	await composer.getByRole('button', { name: '内容を隠す', exact: true }).click();
	const text = `Guest browser ${randomUUID()}`;
	await composer.getByRole('textbox', { name: 'テキスト', exact: true }).fill(text);
	await page.screenshot({ path: '.config/channel-composer-desktop.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/channel-composer-mobile.png', fullPage: true });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
	await page.setViewportSize({ width: 1280, height: 960 });
	await composer.getByTestId('post-form-submit').click();
	await expect(composer).toHaveCount(0);
	const note = root.locator('[data-gridspace-private-note]').filter({ hasText: text });
	await expect(note).toBeVisible();
	await expect(note.getByText(`@${guest.username}@${new URL(g.origin).host}`, { exact: true })).toBeVisible();
	await page.screenshot({ path: '.config/channel-guest-desktop.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/channel-guest-mobile.png', fullPage: true });
	assert.equal(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
	await note.getByRole('button', { name: 'もっと！', exact: true }).click();
	await page.getByRole('menuitem', { name: /削除/ }).click();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(note).toHaveCount(0);
	assert.ok(!(await api(r, 'channels/timeline', { channelId: fixture.channel.id, limit: 100 }, fixture.resonite.token)).some(item => item.text === text));
	assert.equal((await api(g, 'gridspace/link', {}, guest.token)).state, 'unlinked');
	console.log('No-OAuth channel entry, G identity, desktop/mobile and own-note deletion UI PASS');
	console.log('Local G mention completion preserves host in body and CW; desktop/mobile composer PASS');
	let fileRequests = 0;
	let oversized = true;
	await page.route('**/api/gridspace/private-file', route => { fileRequests++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE' } }) }); });
	await page.route('**/api/gridspace/private-notes', async route => {
		const response = await route.fetch();
		const payload = await response.json();
		if (payload.notes?.length) payload.notes[0] = { ...payload.notes[0], cw: null, text: 'Attachment recovery fixture', files: [{ id: 'unavailable-image', name: 'unavailable.png', type: 'image/png', size: oversized ? 17 * 1024 * 1024 : 10, isSensitive: false, comment: null }] };
		await route.fulfill({ response, json: payload });
	});
	await page.goto(`${g.origin}/gridspace/channels/${fixture.channel.id}`);
	const recoveryCard = root.locator('[data-gridspace-private-note]').filter({ hasText: 'Attachment recovery fixture' });
	await expect(recoveryCard).toBeVisible();
	await page.waitForTimeout(1000);
	assert.equal(fileRequests, 0, 'Oversized images must not auto-download');
	oversized = false;
	await page.reload();
	await expect(recoveryCard.locator('[role=alert]')).toBeVisible();
	await expect(recoveryCard.getByText('Attachment recovery fixture', { exact: true })).toBeVisible();
	assert.ok(fileRequests > 0);
	console.log('Oversized image does not auto-download; one failed image keeps the channel timeline visible PASS');
	assert.deepEqual(errors, []);
} finally { await browser.close(); }
