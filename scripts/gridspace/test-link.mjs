/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { api, eventually, loadSite, savePrivateJson } from './lab.mjs';

const grid = loadSite('.', 0);
const resonite = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
for (const site of [grid, resonite]) site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
const suffix = randomBytes(5).toString('hex');

async function account(site, label = '') {
	const username = `link_${label}${suffix}`;
	const password = randomBytes(24).toString('base64url');
	const user = await api(site, 'admin/accounts/create', { username, password }, site.accounts.admin.token);
	return { id: user.id, username, password, token: user.token };
}
const g = await account(grid);
const r = await account(resonite);
savePrivateJson(resolve('.config/gridspace-link-test-accounts.json'), { grid: g, resonite: r });
const status = () => api(grid, 'gridspace/link', { action: 'status' }, g.token);
const user = (site, username, host, token) => api(site, 'users/show', { username, host }, token);

async function authorize(gridToken = g.token) {
	const started = await api(grid, 'gridspace/link', { action: 'start' }, gridToken);
	const response = await fetch(started.authorizationUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 200, 'Authorization page failed');
	const html = await response.text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/);
	assert.ok(transaction, 'Authorization transaction missing');
	const decision = await fetch(`${resonite.origin}/oauth/decision`, { method: 'POST', redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction[1], login_token: r.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	assert.equal(callback.origin, grid.origin);
	return { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey };
}

for (const name of ['author', 'locked', 'reader']) {
	await api(resonite, 'following/create', { userId: resonite.accounts[name].id }, r.token);
}
await api(resonite, 'following/requests/accept', { userId: r.id }, resonite.accounts.locked.token);
await api(resonite, 'mute/create', { userId: resonite.accounts.reader.id }, r.token);

const flow = await authorize();
await assert.rejects(api(grid, 'gridspace/link', { ...flow, clientKey: 'wrong' }, g.token), error => error.code === 'GRIDSPACE_LINK_FAILED');
await assert.rejects(api(grid, 'gridspace/link', flow, grid.accounts.reader.token), error => error.code === 'GRIDSPACE_LINK_FAILED');
await assert.rejects(api(grid, 'gridspace/link', { ...flow, issuer: grid.origin }, g.token), error => error.code === 'GRIDSPACE_LINK_FAILED');
await api(grid, 'gridspace/link', flow, g.token);
await assert.rejects(api(grid, 'gridspace/link', flow, g.token), error => error.code === 'GRIDSPACE_LINK_FAILED');
await eventually('Initial follow copy', async () => (await status()).pending === 0, 60000);
let state = await status();
assert.equal(state.state, 'active');
assert.equal(state.total, 3);
assert.equal(state.skipped, 1);
assert.equal(state.failed, 0);
assert.equal((await api(resonite, 'gridspace/link', { action: 'status' }, r.token)).peerUserId, g.id);
const author = await user(grid, resonite.accounts.author.username, new URL(resonite.origin).host, g.token);
await eventually('Copied author follow accepted', async () => (await user(grid, resonite.accounts.author.username, new URL(resonite.origin).host, g.token)).isFollowing);
const locked = await user(grid, resonite.accounts.locked.username, new URL(resonite.origin).host, g.token);
assert.equal(locked.isFollowing, false);
assert.equal(locked.hasPendingFollowRequestFromYou, true);
console.log('OAuth identity, browser binding, issuer, replay, mirrored link, frozen follow copy and locked approval PASS');

const rival = await account(grid, 'o_');
await assert.rejects(api(grid, 'gridspace/link', await authorize(rival.token), rival.token), error => error.code === 'GRIDSPACE_LINK_FAILED');
assert.equal((await api(grid, 'gridspace/link', { action: 'status' }, rival.token)).state, 'unlinked');
assert.equal((await api(resonite, 'gridspace/link', { action: 'status' }, r.token)).peerUserId, g.id);
console.log('A second account cannot claim an already linked identity PASS');

const text = `GridSpace OAuth home test ${suffix}`;
const note = (await api(resonite, 'notes/create', { text, visibility: 'home' }, resonite.accounts.author.token)).createdNote;
await eventually('Home note delivered through copied follow', async () => (await api(grid, 'notes/timeline', { limit: 100 }, g.token)).some(item => item.uri === `${resonite.origin}/notes/${note.id}` && item.text === text), 30000);
assert.equal((await api(grid, 'notes/local-timeline', { limit: 100 }, g.token)).some(item => item.text === text), false);
console.log('R home note appears in G home, not G local timeline PASS');

await api(grid, 'following/delete', { userId: author.id }, g.token);
await api(grid, 'following/requests/cancel', { userId: locked.id }, g.token);
assert.equal((await api(resonite, 'users/show', { userId: resonite.accounts.author.id }, r.token)).isFollowing, true);
await api(resonite, 'following/create', { userId: resonite.accounts.admin.id }, r.token);
await api(grid, 'gridspace/link', await authorize(), g.token);
state = await status();
assert.equal(state.total, 3, 'Reauthorization refreshed the frozen snapshot');
assert.equal((await user(grid, resonite.accounts.author.username, new URL(resonite.origin).host, g.token)).isFollowing, false, 'Reauthorization resurrected an unfollow');
assert.equal(state.items.some(item => item.uri === `${resonite.origin}/users/${resonite.accounts.admin.id}`), false);
assert.equal((await user(grid, resonite.accounts.locked.username, new URL(resonite.origin).host, g.token)).hasPendingFollowRequestFromYou, false);
assert.equal(state.requested, 0);
console.log('Follow changes remain independent; reauthorization never recopies or resurrects PASS');

const oldFlow = await authorize();
await api(resonite, 'gridspace/link', { action: 'revoke' }, r.token);
await eventually('Remote unlink reaches G', async () => (await status()).state === 'revoked', 30000);
await assert.rejects(api(grid, 'gridspace/link', oldFlow, g.token), error => error.code === 'GRIDSPACE_LINK_FAILED');
assert.equal((await status()).state, 'revoked');
console.log('Remote unlink and stale callback rejection PASS');
await api(grid, 'gridspace/link', await authorize(), g.token);
assert.equal((await status()).total, 3);
assert.equal((await user(grid, resonite.accounts.author.username, new URL(resonite.origin).host, g.token)).isFollowing, false);
console.log('Relinking retains the original snapshot and manual unfollows PASS');
console.log('Link integration checks passed. Test credentials are in the ignored .config/gridspace-link-test-accounts.json.');
