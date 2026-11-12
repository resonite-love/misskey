/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { api, eventually, loadSite } from './lab.mjs';

const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 30000 });
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-reactions-test-accounts.json', 'utf8'));
const privateFixture = JSON.parse(readFileSync('.config/gridspace-actions-test-accounts.json', 'utf8'));
const ready = site => eventually(`${site.role} ready`, async () => { try { await api(site, 'ping'); return true; } catch { return false; } }, 30000);
for (const site of [g, r]) await ready(site);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let stopped = false;
const control = action => {
	// Do not let the restarted long-lived server retain spawnSync's output pipes.
	const process = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/gridspace/server-control.ps1'), '-Action', action, '-Repository', r.repo], { windowsHide: true, stdio: 'ignore' });
	assert.equal(process.status, 0, `Lab ${action} failed`);
};
try {
	async function login(user) {
		await api(g, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
		const account = { ...await api(g, 'i', {}, user.token), token: user.token };
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(({ account }) => {
			localStorage.setItem('account', JSON.stringify(account)); localStorage.setItem('lang', 'ja-JP');
			localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		}, { account });
		const page = await context.newPage(); page.setDefaultTimeout(30000); return { context, page };
	}
	const { context, page } = await login(fixture.grid);
	for (const [site, note, user] of [[g, fixture.custom.copy, fixture.grid], [r, fixture.custom.local, fixture.resonite]]) {
		if ((await api(site, 'notes/extended-reactions/show', { noteIds: [note.id] }, user.token))[0].myReactions.includes('🎉')) await api(site, 'notes/extended-reactions/delete', { noteId: note.id, reaction: '🎉' }, user.token);
	}
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	let lists = 0;
	page.on('request', request => { if (request.url().endsWith('/api/notes/extended-reactions/list')) lists++; });
	await page.goto(`${g.origin}/notes/${fixture.custom.copy.id}`, { waitUntil: 'domcontentloaded' });
	const custom = page.locator(`button[data-reaction=":${fixture.custom.name}@${new URL(r.origin).host}:"]`);
	await expect(custom).toBeVisible();
	await expect.poll(() => custom.locator('img').first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
	await api(r, 'notes/extended-reactions/create', { noteId: fixture.custom.local.id, reaction: '🎉' }, fixture.resonite.token);
	const sourceCount = (await api(r, 'notes/extended-reactions/show', { noteIds: [fixture.custom.local.id] }, fixture.resonite.token))[0].reactions['🎉'];
	const chip = page.locator('button[data-reaction="🎉"]');
	await expect(chip).toBeVisible();
	await chip.click(); await expect(chip).toHaveAttribute('aria-pressed', 'true');
	assert.ok((await api(g, 'notes/extended-reactions/show', { noteIds: [fixture.custom.copy.id] }, fixture.grid.token))[0].myReactions.includes('🎉'));
	assert.equal((await api(r, 'notes/extended-reactions/show', { noteIds: [fixture.custom.local.id] }, fixture.resonite.token))[0].reactions['🎉'], sourceCount + 1);
	await chip.click(); await page.getByTestId('modal-dialog-ok').click(); await expect(chip).toHaveAttribute('aria-pressed', 'false');
	await page.mouse.move(0, 0);
	await expect.poll(async () => (await api(r, 'notes/extended-reactions/show', { noteIds: [fixture.custom.local.id] }, fixture.resonite.token))[0].reactions['🎉']).toBe(sourceCount);
	await page.screenshot({ path: '.config/reactions-public.png', fullPage: true });
	// Wait for one full unchanged poll, then measure another: no per-emoji requests.
	await page.waitForTimeout(12000); const baseline = lists; await page.waitForTimeout(11000);
	assert.equal(lists, baseline);
	console.log('Peer custom emoji, live polling, current-identity add/remove and unchanged-poll request count PASS');

	const nativePrivate = fixture.fixtures.find(item => item.source === 'R' && item.note.visibility === 'followers');
	// The API block/unblock test intentionally removes this fixture's follow edge.
	const nativeAuthor = await api(g, 'users/show', { username: fixture.resonite.username, host: new URL(r.origin).host }, fixture.grid.token);
	if (!nativeAuthor.isFollowing) await api(g, 'following/create', { userId: nativeAuthor.id }, fixture.grid.token);
	await eventually('restore fixture follow', async () => (await api(g, 'users/show', { userId: nativeAuthor.id }, fixture.grid.token)).isFollowing);
	await eventually('source permits restored follower', async () => (await api(g, 'notes/extended-reactions/show', { noteIds: [nativePrivate.copy.id] }, fixture.grid.token)).some(state => state.complete));
	await page.goto(`${g.origin}/notes/${nativePrivate.copy.id}`, { waitUntil: 'domcontentloaded' });
	const privateThumb = page.locator('button[data-reaction="👍"]');
	await expect(privateThumb).toHaveAttribute('aria-pressed', 'false');
	await privateThumb.click(); await expect(privateThumb).toHaveAttribute('aria-pressed', 'true');
	assert.equal((await api(g, 'notes/extended-reactions/show', { noteIds: [nativePrivate.copy.id] }, fixture.grid.token))[0].myReactions.length, 3);
	await privateThumb.click(); await page.getByTestId('modal-dialog-ok').click();
	await expect(privateThumb).toHaveAttribute('aria-pressed', 'false');
	await page.mouse.move(0, 0);
	await page.screenshot({ path: '.config/reactions-followers.png', fullPage: true });
	console.log('Native federated follower note uses multiple reactions in the ordinary UI PASS');

	const own = fixture.fixtures.find(item => item.source === 'G').note;
	if ((await api(g, 'notes/extended-reactions/show', { noteIds: [own.id] }, fixture.grid.token))[0].myReactions.includes('🙏')) await api(g, 'notes/extended-reactions/delete', { noteId: own.id, reaction: '🙏' }, fixture.grid.token);
	await page.goto(`${g.origin}/notes/${own.id}`, { waitUntil: 'domcontentloaded' });
	await expect(page.locator('button[data-reaction="👍"]')).toBeVisible();
	control('stop'); stopped = true;
	await api(g, 'notes/extended-reactions/create', { noteId: own.id, reaction: '🙏' }, fixture.grid.token);
	const partial = (await api(g, 'notes/extended-reactions/show', { noteIds: [own.id] }, fixture.grid.token))[0];
	assert.equal(partial.complete, false); assert.ok(partial.myReactions.includes('🙏'));
	await expect(page.locator('button[data-reaction="🙏"]')).toHaveAttribute('aria-pressed', 'true');
	await assert.rejects(api(g, 'notes/extended-reactions/create', { noteId: fixture.custom.copy.id, reaction: '🙏' }, fixture.grid.token), error => error.code === 'PEER_UNAVAILABLE');
	await assert.rejects(api(g, 'notes/extended-reactions/list', { noteId: own.id }, fixture.grid.token), error => error.code === 'PEER_UNAVAILABLE');
	control('start'); stopped = false; await ready(r);
	await expect.poll(async () => (await api(g, 'notes/extended-reactions/show', { noteIds: [own.id] }, fixture.grid.token))[0].complete).toBe(true);
	console.log('Actual peer outage: local membership updates, remote writes fail closed, list error and recovery PASS');
	await context.close();

	const privateLogin = await login(privateFixture.grid); const privatePage = privateLogin.page;
	privatePage.on('pageerror', error => errors.push(error.message));
	await privatePage.goto(`${g.origin}/gridspace/private?noteId=${privateFixture.formatted.id}`, { waitUntil: 'domcontentloaded' });
	const privateNote = privatePage.locator('[data-gridspace-private-note]');
	await expect(privateNote).toBeVisible();
	if (await privateNote.locator('summary').count()) await privateNote.locator('summary').click();
	const actions = privatePage.locator('[data-gridspace-note-actions]');
	await actions.getByRole('button', { name: 'リアクション・投票', exact: true }).click();
	await actions.getByRole('button', { name: '🙏', exact: true }).click();
	await expect(actions.getByRole('button', { name: /リアクションを取り消す/ })).toHaveCount(3);
	await actions.locator('button').filter({ has: privatePage.locator('img[alt="🙏"]') }).filter({ hasText: '1' }).click();
	await expect(actions.locator(`a[href="${r.origin}/users/${privateFixture.resonite.id}"]`)).toBeVisible();
	await actions.getByRole('button', { name: /リアクションを取り消す/ }).filter({ has: privatePage.locator('img[alt="🙏"]') }).click();
	await expect(actions.getByRole('button', { name: /リアクションを取り消す/ })).toHaveCount(2);
	await expect(actions.locator(`a[href="${r.origin}/users/${privateFixture.resonite.id}"]`)).toHaveCount(0);
	await privatePage.setViewportSize({ width: 390, height: 844 });
	await privatePage.screenshot({ path: '.config/reactions-private-mobile.png', fullPage: true });
	console.log('Delegated multiple reactions, per-emoji removal, old-identity actor list and mobile UI PASS');
	assert.deepEqual(errors, []);
	await privateLogin.context.close();
} finally {
	if (stopped) { control('start'); await ready(r); }
	await browser.close();
}
