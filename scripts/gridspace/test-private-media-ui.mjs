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
const { chromium } = require('playwright'); const expect = require('@playwright/test').expect.configure({ timeout: 20000 });
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const f = JSON.parse(readFileSync('.config/gridspace-mentions-test-accounts.json', 'utf8'));
const fileName = `private-${f.suffix}.png`; const alt = `Private ALT ${f.suffix}`;
const upload = new FormData(); upload.set('i', f.author.token); upload.set('name', fileName);
upload.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2rSAAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), fileName);
const response = await fetch(`${r.origin}/api/drive/files/create`, { method: 'POST', body: upload, signal: AbortSignal.timeout(15000) }); assert.ok(response.ok);
const file = await response.json(); await api(r, 'drive/files/update', { fileId: file.id, comment: alt }, f.author.token);
const note = (await api(r, 'notes/create', { text: 'Protected media UI', visibility: 'specified', visibleUserIds: [f.old.id], fileIds: [file.id] }, f.author.token)).createdNote;
await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, f.grid.token);
const account = { ...await api(g, 'i', {}, f.grid.token), token: f.grid.token };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
 const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
 await context.addInitScript(({ account, origin }) => {
  if (location.origin === origin) localStorage.setItem('account', JSON.stringify(account));
  localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
  window.revokedBlobs = []; const revoke = URL.revokeObjectURL; URL.revokeObjectURL = value => { window.revokedBlobs.push(value); revoke(value); };
 }, { account, origin: g.origin });
 const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto(`${g.origin}/gridspace/private?noteId=${note.id}`, { waitUntil: 'domcontentloaded' });
 const card = page.locator('[data-gridspace-private-note]');
 await expect(card.locator('img[src^="blob:"]').first()).toBeVisible();
 const blob = await card.locator('img[src^="blob:"]').first().getAttribute('src');
 await card.locator('img[src^="blob:"]').first().click();
 // Native lightbox and its native file information popup, not a bespoke viewer.
 const dots = page.locator('div._acrylic').filter({ hasText: fileName }).locator('button').filter({ has: page.locator('i.ti-dots') });
 await dots.last().click();
 await expect(page.getByText(alt, { exact: true }).last()).toBeVisible();
 await page.screenshot({ path: '.config/mentions15-media.png' });
 await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
 await expect(page.getByText(alt, { exact: true })).toHaveCount(0);
 await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
 assert.ok(await page.evaluate(blob => window.revokedBlobs.includes(blob), blob));
 assert.deepEqual(errors, []);
 console.log('Shared protected image/lightbox/info menu, hidden-tab cleanup including ALT and revoked blob PASS');
} finally { await browser.close(); }
