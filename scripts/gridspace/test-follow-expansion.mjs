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

const g = loadSite('.', 0); const r = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
const roles = new Map(); const pairs = {};
for (const site of [g, r]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
async function pair(label) {
	const result = {};
	for (const [key, site] of [['g', g], ['r', r]]) {
		const password = randomBytes(24).toString('base64url');
		result[key] = { ...await api(site, 'admin/accounts/create', { username: `ex_${label.slice(0, 5)}_${suffix}`, password }, site.accounts.admin.token), password };
		await api(site, 'admin/roles/assign', { roleId: roles.get(site), userId: result[key].id }, site.accounts.admin.token);
	}
	pairs[label] = result;
	return result;
}
async function link(person) {
	const started = await api(g, 'gridspace/link', { action: 'start' }, person.g.token);
	const response = await fetch(started.authorizationUrl, { signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 200);
	const transaction = (await response.text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction_id: transaction, login_token: person.r.token }), signal: AbortSignal.timeout(15000) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	assert.equal(callback.origin, g.origin);
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, person.g.token);
}
const state = person => api(g, 'users/show', { userId: person.g.id }, pairs.viewer.g.token);
const old = person => api(g, 'users/show', { username: person.r.username, host: new URL(r.origin).host }, pairs.viewer.g.token);
const receipt = async person => (await g.db.query('SELECT * FROM gridspace_follow_expansion WHERE "followerId"=$1 AND "targetId"=$2', [pairs.viewer.g.id, person.g.id])).rows[0];
const follows = person => eventually(`automatic follow of ${person.g.username}`, async () => (await state(person)).isFollowing, 60000);
const followOld = async person => api(g, 'following/create', { userId: (await old(person)).id }, pairs.viewer.g.token);
try {
	for (const site of [g, r]) {
		const role = await api(site, 'admin/roles/create', { name: `expansion_${suffix}`, description: 'Temporary isolated follow expansion test role', color: null, iconUrl: null,
			target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0,
			policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 } } }, site.accounts.admin.token);
		roles.set(site, role.id);
	}
	for (const name of ['viewer', 'before', 'later', 'locked', 'cancelled', 'unfollowed', 'muted', 'blocked', 'independent', 'catchup', 'repair', 'afterunlink']) await pair(name);
	savePrivateJson(resolve('.config/gridspace-follow-expansion-test-accounts.json'), pairs);
	const a = pairs.viewer;
	await api(r, 'i/update', { isLocked: true }, pairs.locked.r.token);
	await api(g, 'i/update', { isLocked: true }, pairs.locked.g.token);
	for (const name of ['before', 'later', 'locked', 'cancelled', 'unfollowed', 'muted', 'blocked']) {
		await api(r, 'following/create', { userId: pairs[name].r.id, withReplies: true }, a.r.token);
	}
	await api(r, 'following/requests/accept', { userId: a.r.id }, pairs.locked.r.token);
	await link(pairs.before);
	await link(a);
	await eventually('initial snapshot imported', async () => (await api(g, 'gridspace/link', { action: 'status' }, a.g.token)).pending === 0, 60000);
	await follows(pairs.before);
	await api(g, 'following/create', { userId: pairs.cancelled.g.id }, a.g.token);
	await api(g, 'following/delete', { userId: pairs.cancelled.g.id }, a.g.token);
	await eventually('old follow settled before cancellation', async () => (await old(pairs.unfollowed)).isFollowing);
	await api(g, 'following/delete', { userId: (await old(pairs.unfollowed)).id }, a.g.token);
	await api(g, 'mute/create', { userId: (await old(pairs.muted)).id }, a.g.token);
	await api(g, 'blocking/create', { userId: pairs.blocked.g.id }, a.g.token);
	for (const name of ['later', 'locked', 'cancelled', 'unfollowed', 'muted', 'blocked']) await link(pairs[name]);
	await follows(pairs.later);
	assert.equal((await old(pairs.later)).isFollowing, true);
	const row = (await g.db.query('SELECT "withReplies" FROM following WHERE "followerId"=$1 AND "followeeId"=$2', [a.g.id, pairs.later.g.id])).rows[0];
	assert.equal(row.withReplies, true);
	const note = (await api(g, 'notes/create', { text: `expanded home ${suffix}`, visibility: 'home' }, pairs.later.g.token)).createdNote;
	await eventually('new account home note in ordinary home', async () => (await api(g, 'notes/timeline', { limit: 100 }, a.g.token)).some(item => item.id === note.id));
	console.log('Already linked and later linked accounts automatically followed; source follow, reply preference and home delivery PASS');
	await eventually('locked new account request', async () => (await state(pairs.locked)).hasPendingFollowRequestFromYou);
	assert.equal((await state(pairs.locked)).isFollowing, false);
	assert.equal((await old(pairs.locked)).hasPendingFollowRequestFromYou, true);
	await api(g, 'following/requests/reject', { userId: a.g.id }, pairs.locked.g.token);
	// Model a crash after sending the request, before saving its completion.
	await g.db.query('UPDATE gridspace_follow_expansion SET state=\'pending\', "retryAt"=NOW() WHERE "followerId"=$1 AND "targetId"=$2', [a.g.id, pairs.locked.g.id]);
	await eventually('rejected request remains cancelled on retry', async () => (await receipt(pairs.locked))?.reason === 'USER_UNFOLLOWED');
	assert.equal((await state(pairs.locked)).hasPendingFollowRequestFromYou, false);
	for (const name of ['cancelled', 'muted', 'blocked']) {
		await eventually(`skip ${name}`, async () => (await receipt(pairs[name]))?.state === 'skipped');
		assert.equal((await state(pairs[name])).isFollowing, false);
	}
	assert.equal((await state(pairs.unfollowed)).isFollowing, false);
	console.log('Locked source and destination, rejected request retry, manual unfollow, mute and block PASS');
	await api(g, 'following/delete', { userId: pairs.later.g.id }, a.g.token);
	await link(a);
	await api(r, 'following/create', { userId: pairs.independent.r.id }, a.r.token);
	await link(pairs.independent);
	await link(pairs.catchup);
	await followOld(pairs.catchup);
	await follows(pairs.catchup);
	assert.equal((await state(pairs.later)).isFollowing, false, 'Reauthorization restored a manual unfollow');
	assert.equal((await state(pairs.independent)).isFollowing, false, 'Later source follows were continuously synchronized');
	const sourceFollows = (await r.db.query('SELECT COUNT(*)::int AS count FROM following WHERE "followerId"=$1', [a.r.id])).rows[0].count;
	assert.equal(sourceFollows, 8, 'Mirrored links added follows to the source account');
	console.log('Reauthorization preserves unfollows; existing links catch up; source changes stay independent PASS');
	const young = await pair('young');
	await api(g, 'i/update', { followApprovalLocalSeconds: 3600 }, young.g.token);
	await link(young);
	await followOld(young);
	await eventually('account-age approval remains pending', async () => (await state(young)).hasPendingFollowRequestFromYou);
	assert.equal((await state(young)).isFollowing, false, 'Automatic follow bypassed account-age approval');
	await api(g, 'following/requests/accept', { userId: a.g.id }, young.g.token);
	await follows(young);
	console.log('Account-age approval applies to automatic follows and manual acceptance completes them PASS');
	await link(pairs.repair);
	// Revoke only this disposable fixture's source OAuth grant. The local worker
	// must not turn stale link metadata into authorization, then must recover.
	await r.db.query('DELETE FROM access_token WHERE "userId"=$1 AND name=$2', [pairs.repair.r.id, `${g.origin}/gridspace/v1/oauth-client`]);
	await followOld(pairs.repair);
	await eventually('invalid source grant pauses expansion', async () => (await receipt(pairs.repair))?.reason === 'FOLLOW_FAILED');
	assert.equal((await state(pairs.repair)).isFollowing, false);
	await link(pairs.repair);
	await follows(pairs.repair);
	console.log('Peer authorization failure retries after fresh consent without premature follow PASS');
	await api(g, 'following/invalidate', { userId: a.g.id }, pairs.catchup.g.token);
	await g.db.query('UPDATE gridspace_follow_expansion SET state=\'pending\', "retryAt"=NOW() WHERE "followerId"=$1 AND "targetId"=$2', [a.g.id, pairs.catchup.g.id]);
	await eventually('removed follower stays removed on retry', async () => (await receipt(pairs.catchup))?.reason === 'USER_UNFOLLOWED');
	assert.equal((await state(pairs.catchup)).isFollowing, false);
	console.log('Removing an accepted follower cannot be undone by a pending expansion PASS');
	await followOld(pairs.afterunlink);
	await api(g, 'gridspace/link', { action: 'revoke' }, a.g.token);
	await link(pairs.afterunlink);
	await new Promise(resolveWait => setTimeout(resolveWait, 7000));
	assert.equal((await state(pairs.afterunlink)).isFollowing, false);
	assert.equal((await state(pairs.before)).isFollowing, true, 'Unlink deleted existing follows');
	assert.equal((await state(pairs.locked)).hasPendingFollowRequestFromYou, false);
	console.log('Unlink stops new expansion and retains existing subscriptions PASS');
	console.log('Follow expansion integration checks passed.');
} finally {
	for (const site of [g, r]) {
		if (roles.has(site)) await api(site, 'admin/roles/delete', { roleId: roles.get(site) }, site.accounts.admin.token);
		await site.db.end();
	}
}
