/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, eventually, loadSite, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const Redis = createRequire(resolve('packages/backend/package.json'))('ioredis');
const suffix = randomBytes(5).toString('hex');
const notificationReadScript = readFileSync('packages/backend/src/core/NotificationReadService.ts', 'utf8').match(/notificationReadScript = `([\s\S]*?)`;/)?.[1];
assert.ok(notificationReadScript);
let serial = 0;
const ids = {
	gen: (time = Date.now()) => (time - 946684800000).toString(36).padStart(8, '0') + 'test' + (++serial).toString(36).padStart(4, '0'),
	parseFull: id => ({ date: parseInt(id.slice(0, 8), 36) + 946684800000, additional: BigInt(parseInt(id.slice(8), 36)) }),
};
for (const site of [g, r]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	site.redis = new Redis({ ...site.config.redis, keyPrefix: `${site.config.redis.prefix ?? new URL(site.origin).host}:` });
	assert.equal(site.config.id, 'aidx', 'Synthetic notification fixture expects AIDX lab IDs');
	site.ids = ids;
}
async function create(site, name) {
	return api(site, 'admin/accounts/create', { username: `n_${name}_${suffix}`, password: randomBytes(24).toString('base64url') }, site.accounts.admin.token);
}
async function consent(grid, old, endpoint, options = {}) {
	const started = await api(g, endpoint, { action: 'start', ...options }, grid.token);
	const response = await fetch(started.authorizationUrl);
	const transaction = (await response.text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: old.token }) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	await api(g, endpoint, { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
	return new URL(started.authorizationUrl).searchParams.get('scope');
}
async function seed(site, user, count, base = Date.now() - 60000) {
	const notifications = [];
	for (let i = 0; i < count; i++) {
		const id = site.ids.gen(base + i * 10); const parsed = site.ids.parseFull(id);
		const notification = { id, type: 'test', createdAt: new Date(parsed.date).toISOString() };
		await site.redis.xadd(`notificationTimeline:${user.id}`, `${parsed.date}-${BigInt.asUintN(64, parsed.additional)}`, 'data', JSON.stringify(notification));
		notifications.push(notification);
	}
	return notifications;
}
const denied = promise => assert.rejects(promise, error => ['GRIDSPACE_NOTIFICATIONS_UNAVAILABLE', 'PERMISSION_DENIED', 'ACCESS_DENIED', 'CREDENTIAL_REQUIRED'].includes(error.code));
try {
	// Real Redis, isolated names: uint64 ordering, phantom IDs, idempotency and racing arrival.
	const user = { id: `notification-read-${suffix}` };
	const reads = { state: async (userId, noteIds = [], action = 'status') => {
		const result = await g.redis.eval(notificationReadScript, 3, `notificationTimeline:${userId}`, `latestReadNotification:${userId}`, `readNotifications:${userId}`, action,
			...noteIds.map(id => { const p = ids.parseFull(id); return `${p.date}-${p.additional}`; }));
		return { unreadCount: result[0], isRead: result.slice(1).map(n => n === 1) };
	} };
	const first = await seed(g, user, 3);
	assert.equal((await reads.state(user.id)).unreadCount, 3);
	assert.deepEqual(await reads.state(user.id, [first[1].id], 'read'), { unreadCount: 2, isRead: [true] });
	await reads.state(user.id, [g.ids.gen()], 'read');
	assert.equal((await reads.state(user.id)).unreadCount, 2);
	await Promise.all([reads.state(user.id, [first[1].id], 'read'), seed(g, user, 1, Date.now() - 1000)]);
	assert.equal((await reads.state(user.id)).unreadCount, 3);
	await reads.state(user.id, [], 'all'); assert.equal((await reads.state(user.id)).unreadCount, 0);
	await seed(g, user, 1, Date.now()); assert.equal((await reads.state(user.id)).unreadCount, 1);
	await g.redis.del(`notificationTimeline:${user.id}`, `latestReadNotification:${user.id}`, `readNotifications:${user.id}`);
	const keys = [`uint64:${suffix}`, `uint64-mark:${suffix}`, `uint64-seen:${suffix}`];
	await g.redis.xadd(keys[0], '1000-9', 'data', '{}'); await g.redis.xadd(keys[0], '1000-10', 'data', '{}'); await g.redis.xadd(keys[0], '1000-18446744073709551615', 'data', '{}');
	await g.redis.set(keys[1], '1000-9');
	assert.deepEqual(await g.redis.eval(notificationReadScript, 3, ...keys, 'read', '1000-10'), [1, 1]);
	await g.redis.del(...keys);
	console.log('Redis partial read, all-read watermark, racing arrival and uint64 ordering PASS');
	const grid = await create(g, 'g'); const old = await create(r, 'r'); const author = await create(r, 'a');
	await consent(grid, old, 'gridspace/link');
	await eventually('link active', async () => (await api(g, 'gridspace/link', {}, grid.token)).state === 'active');
	await consent(grid, old, 'gridspace/private-grant', { withReply: true });
	await denied(api(g, 'gridspace/notifications', { source: 'peer' }, grid.token));
	const scopes = await consent(grid, old, 'gridspace/private-grant', { withNotifications: true });
	assert.ok(scopes.includes('write:gridspace-reply')); assert.ok(scopes.includes('read:gridspace-notifications')); assert.ok(scopes.includes('write:gridspace-notifications'));
	const status = await api(g, 'gridspace/private-grant', {}, grid.token);
	assert.equal(status.canReadNotifications, true); assert.equal(status.canReply, true);
	await denied(api(r, 'gridspace/notifications', { source: 'peer' }, old.token));
	console.log('Explicit notification consent, preserved reply scope, reverse grant stays read-only PASS');
	await Promise.all([seed(g, grid, 85), seed(r, old, 85)]);
	async function list(source, token = grid.token) { return api(g, 'gridspace/notifications', { source, limit: 40 }, token); }
	for (const source of ['local', 'peer']) {
		const seen = new Set(); let before; let page;
		do {
			page = await api(g, 'gridspace/notifications', { source, before, limit: 40 }, grid.token);
			for (const item of page[source === 'peer' ? 'remote' : 'local']) { assert.equal(seen.has(item.id), false); seen.add(item.id); }
			before = page.next;
		} while (before);
		assert.equal(seen.size, 85); assert.equal(page.unreadCount, 85);
	}
	const page = await list('peer'); const displayed = page.remote[0].id;
	await api(r, 'notifications/test-notification', {}, old.token);
	await eventually('new unread', async () => (await list('peer')).unreadCount === 86);
	const partial = await api(g, 'gridspace/notifications/read', { source: 'peer', ids: [displayed] }, grid.token);
	assert.equal(partial.unreadCount, 85);
	assert.equal((await api(r, 'i', {}, old.token)).unreadNotificationsCount, 85);
	assert.equal((await api(g, 'gridspace/notifications', { source: 'peer', ids: [displayed] }, grid.token)).remote[0].isRead, true);
	assert.equal((await list('local')).unreadCount, 85);
	const weak = await api(g, 'miauth/gen-token', { session: null, permission: ['read:notifications'], name: 'notification-fixture' }, grid.token);
	await denied(list('peer', weak.token));
	const injected = await api(g, 'gridspace/notifications', { source: 'peer', countOnly: true, accessToken: 'bad', linkId: 'bad', localUserId: 'bad' }, grid.token);
	assert.equal(injected.recipientId, old.id);
	console.log('85-item paging per source, passive fetch, partial seen, new unread preserved and API credential isolation PASS');
	const note = (await api(r, 'notes/create', { text: `@${old.username} private notification ${suffix}`, cw: 'Notification test', visibility: 'specified', localOnly: true, visibleUserIds: [old.id] }, author.token)).createdNote;
	await eventually('private mention', async () => (await list('peer')).remote.some(n => n.note?.id === note.id));
	const privateNotice = (await list('peer')).remote.find(n => n.note?.id === note.id);
	assert.equal(privateNotice.note.text.includes(suffix), true);
	await api(r, 'notes/delete', { noteId: note.id }, author.token);
	assert.equal((await api(g, 'gridspace/notifications', { source: 'peer', ids: [privateNotice.id] }, grid.token)).remote.length, 0);
	const cached = await fetch(`${g.origin}/api/gridspace/notifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: grid.token, source: 'peer', countOnly: true }) });
	assert.equal(cached.headers.get('cache-control'), 'no-store'); await cached.body.cancel();
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, grid.token);
	await denied(list('peer')); assert.ok((await list('local')).local.length);
	await consent(grid, old, 'gridspace/private-grant', { withNotifications: true });
	const upload = new FormData(); upload.set('i', author.token);
	upload.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'notification.png');
	const uploaded = await fetch(`${r.origin}/api/drive/files/create`, { method: 'POST', body: upload }); assert.equal(uploaded.status, 200);
	const file = await uploaded.json();
	const live = (await api(r, 'notes/create', { text: `@${old.username} live notification ${suffix}`, fileIds: [file.id], visibility: 'specified', localOnly: true, visibleUserIds: [old.id] }, author.token)).createdNote;
	savePrivateJson(resolve('.config/gridspace-notification-test-accounts.json'), { grid, old, author, live });
	console.log('Private mention, note deletion, no-store response and revoked-grant isolation PASS');
} finally { await Promise.all([g.redis.quit(), r.redis.quit()]); }
