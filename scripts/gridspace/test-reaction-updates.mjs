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

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-reactions-test-accounts.json', 'utf8'));
const require = createRequire(resolve('packages/frontend/package.json'));
const { chromium } = require('playwright'); const { expect: baseExpect } = require('@playwright/test');
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const expect = baseExpect.configure({ timeout: 30000 });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ready = site => eventually(`${site.role} ready`, async () => { try { await api(site, 'ping'); return true; } catch { return false; } }, 45000);
let stopped = false;
const control = (site, action) => {
	const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/gridspace/server-control.ps1'), '-Action', action, '-Repository', site.repo], { windowsHide: true, stdio: 'ignore' });
	assert.equal(result.status, 0, `Lab ${site.role} ${action} failed`);
};
try {
	for (const site of [g, r]) {
		await ready(site);
		const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
		site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
		await site.db.connect();
	}
	for (const [source, target, author, reader] of [[r, g, fixture.resonite, fixture.grid], [g, r, fixture.grid, fixture.resonite]]) {
		const note = (await api(source, 'notes/create', { text: 'Reaction push integration test', localOnly: true }, author.token)).createdNote;
		let copy;
		await eventually('note delivered', async () => { copy = (await target.db.query('SELECT id FROM note WHERE uri=$1', [`${source.origin}/notes/${note.id}`])).rows[0]; return copy; }, 60000);
		await api(target, 'i/registry/set', { scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 }, reader.token);
		const account = { ...await api(target, 'i', {}, reader.token), token: reader.token };
		const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ja-JP' });
		await context.addInitScript(({ account }) => {
			localStorage.setItem('account', JSON.stringify(account)); localStorage.setItem('lang', 'ja-JP');
			localStorage.setItem('neverShowDonationInfo', 'true'); localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
		}, { account });
		const page = await context.newPage(); let reads = 0; let push = false;
		page.on('response', async response => {
			if (response.url().endsWith('/api/notes/extended-reactions/show') && response.ok()) {
				reads++;
				push ||= (await response.json()).some(state => state.noteId === copy.id && state.push === true && state.complete);
			}
		});
		await page.goto(`${target.origin}/notes/${copy.id}`, { waitUntil: 'domcontentloaded' });
		await eventually('push capability advertised', () => push);
		await page.waitForTimeout(4000); const baseline = reads;
		await page.waitForTimeout(12000); assert.equal(reads, baseline, 'Unchanged notes must not poll');
		const chip = reaction => page.locator(`button[data-reaction="${reaction}"]`);
		await api(source, 'notes/reactions/create', { noteId: note.id, reaction: '👍' }, author.token);
		await expect(chip('👍')).toBeVisible();
		await api(source, 'notes/extended-reactions/create', { noteId: note.id, reaction: '🎉' }, author.token);
		await expect(chip('🎉')).toBeVisible();
		await api(source, 'notes/reactions/delete', { noteId: note.id }, author.token);
		await expect(chip('👍')).toHaveCount(0);
		await api(source, 'notes/extended-reactions/delete', { noteId: note.id, reaction: '🎉' }, author.token);
		await expect(chip('🎉')).toHaveCount(0);
		let failed = 0;
		await page.route('**/api/notes/extended-reactions/show', async route => { if (failed++ === 0) await route.abort(); else await route.continue(); });
		await api(source, 'notes/extended-reactions/create', { noteId: note.id, reaction: '🚀' }, author.token);
		await expect(chip('🚀')).toBeVisible(); assert.ok(failed >= 2, 'A failed event read must retry without another reaction');
		await page.unroute('**/api/notes/extended-reactions/show');
		console.log(`${source.role}->${target.role}: no idle polling, primary/extra add/remove, event-read failure recovery PASS`);
		if (target === g) {
			control(g, 'stop'); stopped = true;
			await api(source, 'notes/extended-reactions/create', { noteId: note.id, reaction: '🌟' }, author.token);
			await eventually('durable failed update queued', async () => (await source.db.query('SELECT attempts FROM gridspace_reaction_delivery WHERE "noteId"=$1', [note.id])).rows.some(row => row.attempts > 0), 30000);
			control(g, 'start'); stopped = false; await ready(g);
			await expect(chip('🌟')).toBeVisible();
			await eventually('outbox drained after receiver restart', async () => (await source.db.query('SELECT 1 FROM gridspace_reaction_delivery WHERE "noteId"=$1', [note.id])).rowCount === 0, 45000);
			console.log('Receiver outage: persisted update, backoff, restart, stream reconnect and eventual delivery PASS');
		}
		await context.close();
	}
} finally {
	if (stopped) control(g, 'start');
	await browser.close();
	await Promise.all([g, r].map(site => site.db?.end()));
}
