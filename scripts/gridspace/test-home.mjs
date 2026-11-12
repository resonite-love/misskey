/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { api, loadSite } from './lab.mjs';

// Run test-private.mjs first. Only dedicated lab accounts/data are changed.
const fixture = JSON.parse(readFileSync('.config/gridspace-private-test-accounts.json', 'utf8'));
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const expect = require('@playwright/test').expect.configure({ timeout: 30000 });
const roles = new Map(); const prefix = `Home-${randomBytes(5).toString('hex')}`;
const created = []; let browser; let page;
const diagnostics = [];
const post = async (site, user, body) => {
	const note = (await api(site, 'notes/create', { localOnly: true, ...body }, user.token)).createdNote;
	created.push({ site, user, note }); return note;
};
const privateHome = (params = {}) => api(g, 'gridspace/private-notes', { mode: 'home', withReplies: false, withRenotes: false, ...params }, fixture.grid.token);
try {
	for (const [site, users] of [[g, [fixture.grid]], [r, [fixture.resonite, fixture.author]]]) {
		site.admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
		const role = await api(site, 'admin/roles/create', {
			name: prefix, description: 'Temporary home integration fixture', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } },
		}, site.admin.token);
		roles.set(site, role.id);
		for (const user of users) await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, site.admin.token);
	}
	const remote = await api(g, 'users/show', { userId: fixture.remote.id }, fixture.grid.token);
	if (!remote.isFollowing && !remote.hasPendingFollowRequestFromYou) await api(g, 'following/create', { userId: remote.id }, fixture.grid.token);
	assert.equal((await api(g, 'gridspace/private-grant', {}, fixture.grid.token)).granted, true);
	const normals = []; const privates = [];
	for (let i = 0; i < 18; i++) {
		normals.push(await post(g, fixture.grid, { text: `${prefix} ordinary ${i}` }));
		privates.push(await post(r, fixture.author, { visibility: 'followers', text: `${prefix} delegated ${i}` }));
	}
	const parent = await post(r, fixture.resonite, { text: `${prefix} parent` });
	const reply = await post(r, fixture.author, { text: `${prefix} reply`, visibility: 'specified', visibleUserIds: [fixture.resonite.id], replyId: parent.id });
	const quote = await post(r, fixture.author, { text: null, cw: `${prefix} quote`, visibility: 'followers', renoteId: parent.id });
	const matching = await privateHome({ query: prefix, limit: 20 });
	assert.ok(matching.notes.some(note => note.id === reply.id), 'Reply to the old viewer missing');
	assert.ok(matching.notes.some(note => note.id === quote.id), 'CW-only quote missing');
	assert.ok(Number.isFinite(Date.parse(matching.observedAt)));
	assert.ok(matching.notes.every(note => note.uri === `${r.origin}/notes/${note.id}`));
	assert.equal((await api(g, 'notes/timeline', { limit: 100 }, fixture.grid.token)).some(note => note.text?.startsWith(`${prefix} delegated`)), false);
	console.log('Old-only followers and addressed replies, quote filters, URI and server clock PASS');

	await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, fixture.grid.token);
	const account = { ...await api(g, 'i', {}, fixture.grid.token), token: fixture.grid.token };
	browser = await chromium.launch({ headless: true, channel: 'chrome' });
	const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
	await context.addInitScript(account => {
		localStorage.setItem('account', JSON.stringify(account)); localStorage.setItem('lang', 'ja-JP');
		localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, account);
	page = await context.newPage(); page.setDefaultTimeout(30000);
	page.on('response', async response => {
		if (!/\/api\/gridspace\/private-(grant|notes)$/.test(response.url())) return;
		const body = await response.json().catch(() => null);
		diagnostics.push({ endpoint: response.url().split('/').pop(), status: response.status(), code: body?.error?.code, reason: body?.error?.info?.reason, count: body?.notes?.length, more: !!body?.cursor });
	});
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(g.origin, { waitUntil: 'domcontentloaded' });
	await expect(page.getByText(`${prefix} delegated 17`, { exact: true })).toBeVisible();
	await expect(page.getByText(`${prefix} ordinary 17`, { exact: true })).toBeVisible();
	assert.equal(await page.locator('[data-gridspace-private]').count(), 0, 'Home must not create a separate private section');
	for (let attempt = 0; attempt < 120 && (!await page.getByText(`${prefix} delegated 0`, { exact: true }).count() || !await page.getByText(`${prefix} ordinary 0`, { exact: true }).count()); attempt++) {
		const more = page.getByRole('button', { name: 'もっと見る', exact: true });
		if (await more.count()) await more.click();
		await page.waitForTimeout(500);
	}
	await expect(page.getByText(`${prefix} delegated 0`, { exact: true })).toHaveCount(1);
	const order = await page.locator('[data-scroll-anchor]').evaluateAll(elements => elements.map(el => el.getAttribute('data-scroll-anchor')));
	const expected = [...normals.map(note => ({ ...note, uri: `${g.origin}/notes/${note.id}` })), ...privates.map(note => ({ ...note, uri: `${r.origin}/notes/${note.id}` }))].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(note => note.uri);
	assert.deepEqual(order.filter(uri => expected.includes(uri)), expected);
	assert.equal(new Set(order).size, order.length);
	console.log('One ordinary home, mixed chronological pagination and no duplicate rows PASS');
	await page.screenshot({ path: '.config/home-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '.config/home-mobile.png' });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

	// Over one page of new private notes must survive polling while reading history.
	for (let i = 0; i < 25; i++) await post(r, fixture.author, { visibility: 'followers', text: `${prefix} live ${i}` });
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	const fresh = page.getByRole('button', { name: /新しいノート/ });
	await expect(fresh).toBeVisible(); await fresh.click();
	await expect(page.getByText(`${prefix} live 24`, { exact: true })).toBeVisible();
	await expect(page.getByText(`${prefix} live 0`, { exact: true })).toHaveCount(1);
	console.log('More than 20 live delegated notes enter the normal new-note queue PASS');
	const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
	assert.equal(stored.includes(`${prefix} delegated`), false);
	assert.equal(stored.includes(`${prefix} live`), false);

	await page.route('**/api/gridspace/private-notes', route => route.abort('failed'));
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.locator('[data-gridspace-private-note]')).toHaveCount(0);
	await expect(page.getByText('連携先の限定投稿を取得できませんでした。ほかの投稿は引き続き表示しています。')).toBeVisible();
	await expect(page.getByText(`${prefix} ordinary 17`, { exact: true })).toHaveCount(1);
	await page.unroute('**/api/gridspace/private-notes');
	await page.getByRole('button', { name: '再試行', exact: true }).click();
	await expect(page.getByText(`${prefix} live 24`, { exact: true })).toBeVisible();
	console.log('Delegated failure clears bodies and keeps ordinary home; retry recovers PASS');
	const subscription = await api(g, 'users/show', { userId: remote.id }, fixture.grid.token);
	await api(g, subscription.isFollowing ? 'following/delete' : 'following/requests/cancel', { userId: remote.id }, fixture.grid.token);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText(`${prefix} live 24`, { exact: true })).toHaveCount(0);
	assert.equal((await privateHome({ query: prefix })).notes.some(note => note.author.username === fixture.author.username), false);
	console.log('Destination unfollow clears displayed and queued old-authorized notes PASS');
	assert.deepEqual(errors, []);
} catch (error) {
	console.error(error.message);
	console.error(JSON.stringify(diagnostics));
	await page?.screenshot({ path: '.config/home-failure.png' });
	throw error;
} finally {
	await browser?.close();
	// Preserve the existing fixture; remove only this run's temporary notes/roles.
	for (const { site, user, note } of created.reverse()) await api(site, 'notes/delete', { noteId: note.id }, user.token).catch(() => {});
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.admin.token);
}
