/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { api, eventually, loadSite } from './lab.mjs';
const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1); const e = loadSite('../gridspace-external-test', 2);
const fixture = JSON.parse(readFileSync('.config/gridspace-notification-test-accounts.json', 'utf8'));
const admin = JSON.parse(readFileSync(e.accountsPath, 'utf8')).accounts.admin.token;
async function grant() {
	const started = await api(g, 'gridspace/private-grant', { action: 'start', withActions: true, withNotifications: true }, fixture.grid.token);
	assert.ok(new URL(started.authorizationUrl).searchParams.get('scope').split(' ').includes('write:following'));
	const transaction = (await (await fetch(started.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1]; assert.ok(transaction);
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: fixture.old.token }) });
	assert.equal(decision.status, 302); const callback = new URL(decision.headers.get('location'));
	await api(g, 'gridspace/private-grant', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, fixture.grid.token);
	assert.equal((await api(g, 'gridspace/private-grant', {}, fixture.grid.token)).canManageFollowRequests, true);
}
await grant(); await api(r, 'i/update', { isLocked: true }, fixture.old.token);
const sourceNotifications = () => api(g, 'gridspace/notifications', { source: 'peer' }, fixture.grid.token);
for (const accept of [true, false]) {
	const user = await api(e, 'admin/accounts/create', { username: `nf_${randomBytes(5).toString('hex')}`, password: randomBytes(24).toString('hex') }, admin);
	const target = await api(e, 'users/show', { username: fixture.old.username, host: new URL(r.origin).host }, user.token);
	await api(e, 'following/create', { userId: target.id }, user.token);
	let notice;
	await eventually('source follow request arrives through ordinary ActivityPub', async () => {
		notice = (await sourceNotifications()).remote.find(n => n.type === 'receiveFollowRequest' && n.user?.username === user.username && n.presentation?.followRequestId);
		return !!notice;
	}, 60000);
	assert.equal(notice.presentation.canManageFollowRequest, true); assert.equal(notice.presentation.user.host, new URL(e.origin).host);
	const params = { notificationId: notice.id, followRequestId: notice.presentation.followRequestId, accept };
	await assert.rejects(api(g, 'gridspace/notifications/follow-request', { ...params, followRequestId: 'wrongrequest' }, fixture.grid.token), err => err.code === 'GRIDSPACE_NOTIFICATION_ACTION_UNAVAILABLE');
	await api(g, 'gridspace/notifications/follow-request', params, fixture.grid.token);
	await api(g, 'gridspace/notifications/follow-request', params, fixture.grid.token);
	await eventually('ordinary external server receives decision', async () => {
		const state = await api(e, 'users/show', { userId: target.id }, user.token);
		return state.isFollowing === accept && !state.hasPendingFollowRequestFromYou;
	}, 60000);
	assert.equal((await api(g, 'gridspace/notifications', { source: 'peer', ids: [notice.id] }, fixture.grid.token)).remote[0]?.presentation.followRequestId ?? null, null);
	console.log(`Delegated ${accept ? 'Accept' : 'Reject'}: exact request binding, duplicate retry and ordinary external Misskey delivery PASS`);
}
