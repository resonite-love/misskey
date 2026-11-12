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

// Reuse only the dedicated, mutually authorized fixture from test-private.mjs.
const fixture = JSON.parse(readFileSync('.config/gridspace-private-test-accounts.json', 'utf8'));
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect } = require('@playwright/test');
const prefix = `Lists-${randomBytes(5).toString('hex')}`;
const countPerKind = 21;
const mocked = process.argv.includes('--mock');
console.log(mocked ? 'Mode: fixed API responses (UI only)' : 'Mode: real peer APIs');
const created = []; const roles = new Map(); let browser; let page;

async function post(site, user, visibility, index) {
	const input = { localOnly: true, visibility, visibleUserIds: visibility === 'specified' ? [user.id] : [], text: `${prefix} ${site.role} ${visibility} ${index}` };
	const note = mocked ? { ...input, id: `fixture${created.length}`, createdAt: new Date(Date.now() - 60000 + created.length * 1000).toISOString(),
		userId: user.id, user: site.actor, cw: null, files: [], fileIds: [], emojis: {}, reactions: {}, reactionCount: 0, renoteCount: 0, repliesCount: 0,
		replyId: null, renoteId: null, channelId: null, reactionAcceptance: null } : (await api(site, 'notes/create', input, user.token)).createdNote;
	created.push({ site, user, note, uri: `${site.origin}/notes/${note.id}` });
}

try {
	for (const [site, user] of [[g, fixture.grid], [r, fixture.resonite]]) {
		if (mocked) {
			// Fixed API responses exercise the built UI independently of peer availability.
			site.actor = await api(site, 'users/show', { userId: user.id }, user.token);
			continue;
		}
		site.admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
		assert.equal((await api(site, 'gridspace/private-grant', {}, user.token)).available, true);
		const role = await api(site, 'admin/roles/create', {
			name: prefix, description: 'Temporary combined-list fixture', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false,
			asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 }, canSearchNotes: { useDefault: false, priority: 2, value: true } },
		}, site.admin.token);
		roles.set(site, role.id);
		await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, site.admin.token);
	}
	for (let i = 0; i < countPerKind; i++) {
		await post(g, fixture.grid, 'public', i);
		await post(r, fixture.resonite, 'specified', i);
		await post(r, fixture.resonite, 'public', i);
		await post(g, fixture.grid, 'specified', i);
	}
	const expected = [...created].sort((a, b) => Date.parse(b.note.createdAt) - Date.parse(a.note.createdAt) || (a.uri < b.uri ? -1 : 1)).map(item => item.uri);
	const keys = new Set(expected);
	browser = await chromium.launch({ headless: true, channel: 'chrome' });
	for (const [site, user] of [[g, fixture.grid], [r, fixture.resonite]]) {
		await api(site, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, user.token);
		const account = { ...await api(site, 'i', {}, user.token), token: user.token };
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(account => {
			localStorage.setItem('account', JSON.stringify(account)); localStorage.setItem('lang', 'ja-JP');
			localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
			localStorage.setItem('preferences', JSON.stringify({ id: 'lists-test', type: 'main', version: '1', modifiedAt: Date.now(), name: 'lists-test', preferences: { enableInfiniteScroll: [[{}, false, {}]] } }));
		}, account);
		page = await context.newPage(); page.setDefaultTimeout(30000);
		if (mocked) {
			const peer = site === g ? r : g;
			await page.route('**/api/gridspace/**', async route => {
				const endpoint = route.request().url().split('/').pop();
				const params = route.request().postDataJSON();
				if (endpoint === 'member') return route.fulfill({ json: { enabled: true, linked: true, available: true, accounts: [site.actor, { ...peer.actor, host: new URL(peer.origin).host }] } });
				if (endpoint === 'private-grant') return route.fulfill({ json: { enabled: true, granted: true, available: true } });
				if (!['history', 'search', 'private-notes'].includes(endpoint)) return route.fallback();
				const privateRequest = endpoint === 'private-notes';
				const items = created.filter(item => (item.site !== site && item.note.visibility === 'specified') === privateRequest)
					.filter(item => !params.query || item.note.text.includes(params.query))
					.sort((a, b) => Date.parse(b.note.createdAt) - Date.parse(a.note.createdAt));
				const start = Number(params.cursor ?? 0);
				const selected = params.mode === 'validate' ? items.filter(item => params.ids.includes(item.note.id)) : items.slice(start, start + params.limit);
				const notes = selected.map(item => privateRequest ? {
					...item.note, uri: item.uri, origin: peer.origin,
					author: { ...peer.actor, uri: `${peer.origin}/users/${peer.actor.id}`, host: new URL(peer.origin).host },
				} : { ...item.note, uri: item.site === site ? null : item.uri, user: { ...item.site.actor, host: item.site === site ? null : new URL(peer.origin).host } });
				const cursor = params.mode !== 'validate' && start + selected.length < items.length ? String(start + selected.length) : null;
				return route.fulfill({ json: { notes, users: [], cursor, peerAvailable: true, scannedThrough: cursor ? notes.at(-1).createdAt : null, observedAt: new Date().toISOString() } });
			});
		}
		const errors = []; page.on('pageerror', error => errors.push(error.message));
		const responses = [];
		page.on('response', async response => {
			if (!/\/api\/(gridspace\/(?:member|history|private-grant|private-notes)|users\/notes)$/.test(response.url())) return;
			const body = await response.json().catch(() => null);
			responses.push({ endpoint: response.url().split('/').pop(), requestMode: response.request().postDataJSON()?.mode, status: response.status(), reason: body?.error?.info?.reason, count: body?.notes?.length ?? (Array.isArray(body) ? body.length : undefined), more: !!body?.cursor, linked: body?.linked, available: body?.available });
		});
		const list = page.locator('[data-gridspace-note-list]');
		async function allFixtureRows() {
			await expect(list).toHaveCount(1);
			for (let tries = 0; tries < 100; tries++) {
				const values = await list.locator(':scope > [data-scroll-anchor]').evaluateAll(elements => elements.map(el => el.getAttribute('data-scroll-anchor')));
				if (values.filter(value => keys.has(value)).length >= expected.length) {
					assert.deepEqual(values.filter(value => keys.has(value)), expected);
					return;
				}
				const more = list.getByRole('button', { name: 'もっと見る', exact: true });
				if (await more.count() && await more.isEnabled()) await more.click();
				await page.waitForTimeout(300);
			}
			const found = await list.locator(':scope > [data-scroll-anchor]').evaluateAll(elements => elements.map(el => el.getAttribute('data-scroll-anchor')));
			console.log(JSON.stringify({ responses, expected: expected.length, found: found.filter(value => keys.has(value)).length, missing: created.filter(item => !found.includes(item.uri)).map(item => `${item.site.role}:${item.note.visibility}`), errors }));
			throw new Error(`${site.role}: combined list did not return every fixture row`);
		}
		async function noSeparateSection() {
			await expect(page.locator('[data-gridspace-private]')).toHaveCount(0);
			await expect(page.getByText('連携先の権限で読む投稿', { exact: true })).toHaveCount(0);
			await expect(list.getByText('ノートはありません', { exact: true })).toHaveCount(0);
		}
		await page.goto(`${site.origin}/@${user.username}/notes`, { waitUntil: 'domcontentloaded' });
		await allFixtureRows(); await noSeparateSection();
		assert.equal(await list.locator('[data-gridspace-private-note]').filter({ hasText: prefix }).count(), countPerKind);
		await page.screenshot({ path: `.config/lists-${site.role}-profile-desktop.png` });
		console.log(`${site.role} profile: mixed chronological pages, distinct source identities, no duplicates or separate section PASS`);
		await page.goto(`${site.origin}/search?q=${encodeURIComponent(prefix)}`, { waitUntil: 'domcontentloaded' });
		await page.locator('input[type="search"]').fill(prefix);
		await page.getByRole('button', { name: '検索', exact: true }).click();
		await allFixtureRows(); await noSeparateSection();
		assert.equal(await list.locator('[data-gridspace-private-note]').count(), countPerKind);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: `.config/lists-${site.role}-search-mobile.png` });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		console.log(`${site.role} search: mixed chronological pages, one empty state and mobile layout PASS`);
		// Fail only the next delegated validation; normal notes must remain visible.
		await page.route('**/api/gridspace/private-notes', async route => {
			if (route.request().postDataJSON().mode === 'validate') await route.abort(); else await route.fallback();
		});
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(list.locator('[data-gridspace-private-note]')).toHaveCount(0);
		await expect(list.getByText('一部の投稿を取得できませんでした。', { exact: true })).toBeVisible();
		assert.equal(await list.locator('article').count(), 3 * countPerKind);
		await page.unroute('**/api/gridspace/private-notes');
		await list.getByRole('button', { name: '再試行', exact: true }).click();
		await allFixtureRows();
		console.log(`${site.role} reauthorization failure removes only delegated bodies; retry restores the same ordered list PASS`);
		// A query with ordinary matches only must not show a second empty-state message.
		await page.locator('input[type="search"]').fill(`${prefix} ${site.role} public`);
		await page.getByRole('button', { name: '検索', exact: true }).click();
		await expect(list.locator('article').first()).toBeVisible();
		await noSeparateSection();
		await expect(list.locator('[data-gridspace-private-note]')).toHaveCount(0);
		await page.locator('input[type="search"]').fill(`${prefix} nonexistent`);
		await page.getByRole('button', { name: '検索', exact: true }).click();
		await expect(list.getByText('ノートはありません', { exact: true })).toHaveCount(1);
		assert.deepEqual(errors, []);
		await context.close();
	}
} catch (error) {
	await page?.screenshot({ path: '.config/lists-failure.png' }).catch(() => {});
	throw error;
} finally {
	await browser?.close();
	if (!mocked) for (const { site, user, note } of created.reverse()) await api(site, 'notes/delete', { noteId: note.id }, user.token).catch(() => {});
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.admin.token);
}
