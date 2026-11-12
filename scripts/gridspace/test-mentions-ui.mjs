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
const { chromium } = require('playwright'); const expect = require('@playwright/test').expect.configure({ timeout: 20000 });
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const f = JSON.parse(readFileSync('.config/gridspace-mentions-test-accounts.json', 'utf8'));
await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, f.grid.token);
const account = { ...await api(g, 'i', {}, f.grid.token), token: f.grid.token };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
 const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
 await context.addInitScript(({ account, origin }) => {
  if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
  localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
 }, { account, origin: g.origin });
 const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto(`${g.origin}/my/notifications`, { waitUntil: 'domcontentloaded' });
 await expect(page.getByText('→ れぞらぶ', { exact: true }).first()).toBeVisible();
 await expect(page.getByText(/のアカウント宛て/)).toHaveCount(0);
 await page.getByText('メンション', { exact: true }).click();
 const list = page.locator('[data-gridspace-note-list]');
 await expect(list).toContainText(`public mention ${f.suffix}`);
 await expect(list).toContainText(`Local direct ${f.suffix}`);
 await page.getByText('指名', { exact: true }).click();
 await expect(list).not.toContainText(`public mention ${f.suffix}`);
 await expect(list).toContainText('Private CW');
 await expect(list).toContainText(`Local direct ${f.suffix}`);
 const note = list.locator('[data-gridspace-private-note]').filter({ hasText: 'Private CW' });
 await expect(note.locator('details')).toHaveCount(0);
 await note.getByRole('button', { name: /もっと見る/ }).click();
 await expect(note).toContainText(`Direct without textual mention ${f.suffix}`);
 await note.getByRole('button', { name: '返信', exact: true }).click();
 const form = page.locator('[data-gridspace-post-form]');
 await expect(form).toContainText(`@${f.old.username}@`);
 await expect(form).toContainText('指名');
 const text = `Shared reply ${randomUUID()}`;
 await form.getByTestId('post-form-text').fill(text);
 await form.locator('input[type=file]').setInputFiles({ name: 'reply.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2rSAAAAAASUVORK5CYII=', 'base64') });
 await expect(form.getByTestId('post-form-submit')).toBeEnabled();
 // The CW is inherited from the parent, as with the ordinary composer.
 await expect(form.getByRole('textbox', { name: '注釈', exact: true })).toHaveValue('Private CW');
 let lost = false;
 await page.route('**/api/gridspace/private-reply', async route => {
  if (route.request().postDataJSON().action === 'send' && !lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
 });
 await form.getByTestId('post-form-submit').click();
 await expect(form.getByTestId('post-form-submit')).toContainText('再試行');
 await form.getByTestId('post-form-submit').click();
 await expect(form).toHaveCount(0);
 const replies = (await api(r, 'users/notes', { userId: f.old.id, limit: 30 }, f.old.token)).filter(n => n.text === text);
 assert.equal(replies.length, 1); assert.equal(replies[0].replyId, f.direct.id); assert.equal(replies[0].visibility, 'specified'); assert.equal(replies[0].cw, 'Private CW'); assert.equal(replies[0].files.length, 1);
 await page.unroute('**/api/gridspace/private-reply');
 await page.screenshot({ path: '.config/mentions15-desktop.png' });
 await page.setViewportSize({ width: 390, height: 844 });
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
 await page.screenshot({ path: '.config/mentions15-mobile.png' });
 // A hidden window must drop the detached reply form as well as list bodies.
 await note.getByRole('button', { name: '返信', exact: true }).click();
 await expect(form).toBeVisible();
 await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
 await expect(form).toHaveCount(0);
 await expect(list).not.toContainText(`Direct without textual mention ${f.suffix}`);
 await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
 await expect(list).toContainText('Private CW');
 await api(g, 'gridspace/private-grant', { action: 'revoke' }, f.grid.token);
 await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 await expect(list).not.toContainText('Private CW');
 await expect(list).toContainText(`Local direct ${f.suffix}`);
 await assert.rejects(api(g, 'gridspace/private-notes', { mode: 'mentions' }, f.grid.token));
 assert.deepEqual(errors, []);
 console.log('Actual merged mentions/direct UI, peer-only short label, shared CW/composer, source-account reply with lost-response retry, desktop/mobile, hidden/revoke cleanup PASS');
} finally { await browser.close(); }
