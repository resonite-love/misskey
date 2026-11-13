/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount } from './test-profile-import.mjs';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
async function link(grid, old) {
	const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
	const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const response = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
	assert.equal(response.status, 302);
	const callback = new URL(response.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
}
async function until(read, condition) {
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) { const value = await read(); if (condition(value)) return value; await new Promise(resolve => setTimeout(resolve, 500)); }
	throw new Error('Timed out waiting for source follow expansion');
}
const old = await makeProfileAccount(r); const grid = await makeProfileAccount(g);
const viewer = await makeProfileAccount(r); const muted = await makeProfileAccount(r);
assert.equal((await api(r, 'gridspace/link', {}, viewer.token)).state, 'unlinked');
for (const follower of [viewer, muted]) await api(r, 'following/create', { userId: old.id, withReplies: true }, follower.token);
await api(r, 'mute/create', { userId: old.id }, muted.token);
await link(grid, old);
const remote = await api(r, 'users/show', { username: grid.username, host: new URL(g.origin).host }, viewer.token);
const relation = token => api(r, 'users/show', { userId: remote.id }, token);
await until(() => relation(viewer.token), user => user.isFollowing);
assert.equal((await api(r, 'users/show', { userId: old.id }, viewer.token)).isFollowing, true);
assert.equal((await relation(muted.token)).isFollowing, false);
await api(r, 'following/delete', { userId: remote.id }, viewer.token);
await new Promise(resolve => setTimeout(resolve, 7000));
assert.equal((await relation(viewer.token)).isFollowing, false);
assert.equal((await relation(viewer.token)).hasPendingFollowRequestFromYou, false);
console.log('PASS: unlinked R follower gets G account after target links; old follow retained, mute and manual unfollow respected');
const oldLocked = await makeProfileAccount(r); const gridLocked = await makeProfileAccount(g);
await api(g, 'i/update', { isLocked: true }, gridLocked.token);
await link(gridLocked, oldLocked);
await api(r, 'following/create', { userId: oldLocked.id }, viewer.token);
const target = await api(r, 'users/show', { username: gridLocked.username, host: new URL(g.origin).host }, viewer.token);
await until(() => api(r, 'users/show', { userId: target.id }, viewer.token), user => user.hasPendingFollowRequestFromYou);
assert.equal((await api(r, 'users/show', { userId: target.id }, viewer.token)).isFollowing, false);
console.log('PASS: already-linked target gets new R followers; locked G target remains an ordinary approval request');
