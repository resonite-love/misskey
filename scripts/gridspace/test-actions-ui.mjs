/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, eventually, loadSite } from './lab.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const fixture = JSON.parse(readFileSync('.config/gridspace-actions-test-accounts.json', 'utf8'));
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
for (const site of [g, r]) await eventually(`${site.role} ready`, async () => { try { await api(site, 'ping', {}); return true; } catch { return false; } }, 30000);
fixture.freshPoll = (await api(r, 'notes/create', { text: `Browser poll ${randomUUID()}`, visibility: 'specified', visibleUserIds: [fixture.resonite.id], localOnly: true, poll: { choices: ['browser one', 'browser two'], multiple: false } }, fixture.author.token)).createdNote;
const accounts = {};
for (const [site, user] of [[g, fixture.grid], [r, fixture.resonite]]) {
	await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
	accounts[site.origin] = { ...await api(site, 'i', {}, user.token), token: user.token };
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
	async function contextFor(users) {
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(({ users }) => {
			const account = users[location.origin];
			if (account) localStorage.setItem('account', JSON.stringify(account));
			localStorage.setItem('lang', 'ja-JP'); localStorage.setItem('neverShowDonationInfo', 'true');
			localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		}, { users });
		return context;
	}
	const context = await contextFor(accounts);
	const page = await context.newPage(); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${g.origin}/settings/gridspace`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: '連携の権限をまとめて更新', exact: true }).click();
	await page.waitForURL(`${r.origin}/oauth/authorize**`);
	const accept = page.getByRole('button', { name: '許可', exact: true });
	await expect(accept.or(page.getByRole('button', { name: '続ける', exact: false }))).toBeVisible();
	if (!await accept.isVisible()) {
		await page.locator(`label[for="account-${fixture.resonite.id}"]`).click();
		await page.getByRole('button', { name: '続ける', exact: false }).click();
	}
	await expect(page.getByText('連携先から、このアカウントの名義でリアクション・投票を行い、返信用のファイルをドライブへ保存する', { exact: true })).toBeVisible();
	await accept.click(); await page.waitForURL(`${g.origin}/settings/gridspace**`);
	await expect(page.getByText('限定投稿の閲覧・検索、通知、連携先のアカウント名義での返信・リアクション・投票・添付を利用できます。', { exact: true })).toBeVisible();
	console.log('Actual OAuth action consent PASS');

	await page.goto(`${g.origin}/gridspace/private?noteId=${fixture.formatted.id}`, { waitUntil: 'domcontentloaded' });
	const note = page.locator('[data-gridspace-private-note]');
	await expect(note.locator('summary img')).toBeVisible();
	await note.locator('summary').click();
	await expect(note.getByText('MFM body', { exact: true })).toBeVisible();
	assert.equal(await note.getByText('MFM body', { exact: true }).evaluate(el => el.tagName), 'B');
	await expect.poll(() => note.locator(`img[alt*="${fixture.emojiName}"]`).count()).toBeGreaterThanOrEqual(3);
	await expect.poll(() => note.locator('summary img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
	const mention = note.locator(`a[href*="${fixture.resonite.username}@${new URL(r.origin).host}"]`);
	await expect(mention.first()).toBeVisible();
	await page.screenshot({ path: '.config/actions-mfm.png', fullPage: true });
	console.log('Real MFM body, CW/poll custom emoji, source-host mention PASS');

	await page.goto(`${g.origin}/gridspace/private?noteId=${fixture.freshPoll.id}`, { waitUntil: 'domcontentloaded' });
	const actions = note.locator('[data-gridspace-note-actions]');
	await actions.getByRole('button', { name: 'リアクション・投票', exact: true }).click();
	await expect(actions.getByText(`@${fixture.resonite.username}@${new URL(r.origin).host} として操作します`, { exact: true })).toBeVisible();
	await actions.getByRole('button', { name: '👍', exact: true }).click();
	await expect(actions.getByRole('button', { name: /リアクションを取り消す/ })).toBeVisible();
	await actions.getByRole('button', { name: '投票する', exact: true }).first().click();
	await expect(actions.getByRole('button', { name: '投票する', exact: true }).first()).toBeDisabled();
	const voted = (await api(g, 'gridspace/private-action', { noteId: fixture.freshPoll.id }, fixture.grid.token)).note;
	assert.equal(voted.myReaction, '👍'); assert.equal(voted.poll.choices[0].isVoted, true);
	await actions.getByRole('button', { name: /リアクションを取り消す/ }).click();
	await expect(actions.getByRole('button', { name: /リアクションを取り消す/ })).toHaveCount(0);
	console.log('Old-identity reaction, removal and poll voting UI PASS');

	await note.getByRole('button', { name: /連携先の名義で返信/ }).click();
	const form = note.locator('[data-gridspace-reply]');
	await expect(form.locator('input[type=file]')).toBeVisible();
	await form.locator('input[type=file]').setInputFiles({ name: 'browser.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNw2BL1nxLMMGrA/9EwiBoNgy3DIgwAwJVNH4qw1v8AAAAASUVORK5CYII=', 'base64') });
	await form.getByRole('textbox', { name: 'ファイルの説明', exact: true }).fill('browser attachment alt');
	await form.getByRole('checkbox', { name: 'センシティブなファイル', exact: true }).check();
	const replyText = `Browser attachment ${randomUUID()}`;
	await form.locator('textarea').fill(replyText);
	await form.getByRole('button', { name: 'この名義で返信する', exact: true }).click();
	await expect(form.getByText('返信を投稿しました。', { exact: true })).toBeVisible();
	const sourceNotes = await api(r, 'users/notes', { userId: fixture.resonite.id, limit: 100 }, fixture.resonite.token);
	const created = sourceNotes.find(row => row.text === replyText);
	assert.equal(created.files.length, 1); assert.equal(created.files[0].comment, 'browser attachment alt'); assert.equal(created.files[0].isSensitive, true);
	assert.equal(created.visibility, 'specified'); assert.equal(created.localOnly, true);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/actions-mobile.png', fullPage: true });
	console.log('Old-account attachment reply and mobile layout PASS');
	assert.deepEqual(errors, []);
	await context.close();

	const admin = JSON.parse(readFileSync(g.accountsPath, 'utf8')).accounts.admin;
	const [invite] = await api(g, 'admin/invite/create', { count: 1 }, admin.token);
	const newcomer = await api(g, 'signup', { username: `signup_${randomBytes(5).toString('hex')}`, password: randomBytes(24).toString('base64url'), invitationCode: invite.code });
	const signupContext = await contextFor({ [g.origin]: newcomer });
	const signup = await signupContext.newPage(); signup.setDefaultTimeout(30000);
	await signup.goto(g.origin, { waitUntil: 'domcontentloaded' });
	const guide = signup.locator('[data-gridspace-signup-guide]');
	await expect(guide).toBeVisible();
	await guide.getByRole('button', { name: 'アカウント連携へ進む', exact: true }).click();
	await signup.waitForURL(`${g.origin}/settings/gridspace`);
	await expect(signup.getByRole('button', { name: '初期設定の続きへ戻る', exact: true })).toBeVisible();
	await signup.reload({ waitUntil: 'domcontentloaded' });
	await expect(signup.locator('[data-testid=user-setup-dialog]')).toHaveCount(0);
	await signup.getByRole('button', { name: '初期設定の続きへ戻る', exact: true }).click();
	await expect(signup.locator('[data-testid=user-setup-dialog]')).toHaveCount(1);
	await expect(signup.locator('[data-testid=user-setup-dialog]').getByText('プロフィール設定', { exact: true })).toBeVisible();
	await signup.screenshot({ path: '.config/actions-signup.png', fullPage: true });
	await signupContext.close();
	console.log('Real signup, optional link guidance, reload and setup resume PASS');
} finally { await browser.close(); }
