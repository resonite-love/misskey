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

const g = loadSite('.', 0);
const r = loadSite(process.argv[2] ?? '../resonite-love-gridspace', 1);
const e = loadSite(process.argv[3] ?? '../gridspace-external-test', 2);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
const canonical = (site, note) => note.uri ?? `${site.origin}/notes/${note.id}`;
const post = async (site, author, text, extra = {}) => (await api(site, 'notes/create', { text: `${suffix} ${text}`, localOnly: true, ...extra }, author.token)).createdNote;
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	return { ...await api(site, 'admin/accounts/create', { username: `hv_${label}_${suffix}`, password }, site.admin.token), password };
}
async function collect(site, profile, token, options = {}, first) {
	const result = [];
	let page = first ?? await api(site, 'gridspace/history', { userId: profile.id, limit: 20, ...options }, token);
	for (let i = 0; i < 30; i++) {
		result.push(...page.notes);
		if (!page.cursor) {
			assert.equal(new Set(result.map(note => canonical(site, note))).size, result.length, 'no duplicate source notes');
			assert.ok(result.every((note, n) => n === 0 || new Date(result[n - 1].createdAt) >= new Date(note.createdAt)), 'chronological order');
			return result;
		}
		page = await api(site, 'gridspace/history', { userId: profile.id, limit: 20, ...options, cursor: page.cursor }, token);
	}
	throw new Error('History did not terminate');
}
const contains = (notes, site, note) => notes.some(candidate => canonical(site, candidate) === canonical(site, note));
function assertReadable(actual, expected) {
	assert.ok(actual, 'authorized note is present');
	assert.notEqual(actual.isHidden, true, 'authorized note is not redacted');
	assert.equal(actual.text, expected.text, 'authorized body is readable');
}
async function follow(site, follower, author) {
	await api(site, 'following/create', { userId: author.id }, follower.token);
	await eventually('follow accepted', async () => (await api(site, 'users/show', { userId: author.id }, follower.token)).isFollowing);
}
try {
	for (const site of [g, r, e]) {
		site.admin = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts.admin;
		const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
		site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
		await site.db.connect();
	}
	for (const site of [g, r]) {
		site.visitorPolicy = (await api(site, 'admin/meta', {}, site.admin.token)).ugcVisibilityForVisitor;
		await api(site, 'admin/update-meta', { ugcVisibilityForVisitor: 'all' }, site.admin.token);
		site.author = await account(site, `${site.role.toLowerCase()}a`);
		site.follower = await account(site, `${site.role.toLowerCase()}f`);
		site.outsider = await account(site, `${site.role.toLowerCase()}x`);
	}
	const started = await api(g, 'gridspace/link', { action: 'start' }, g.author.token);
	const html = await (await fetch(started.authorizationUrl)).text();
	const transaction = html.match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)[1];
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: r.author.token }) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, g.author.token);
	savePrivateJson(resolve('.config/gridspace-visibility-test-accounts.json'), { grid: g.author, resonite: r.author, gridFollower: g.follower, resoniteFollower: r.follower });

	for (const [site, peer] of [[g, r], [r, g]]) {
		const { author, follower, outsider } = site;
		const remote = await api(site, 'users/show', { username: peer.author.username, host: new URL(peer.origin).host }, follower.token);
		await follow(site, follower, author);
		await follow(site, follower, remote);
		const remoteFollower = await api(peer, 'users/show', { username: follower.username, host: new URL(site.origin).host }, peer.author.token);
		const localFollowers = await post(site, author, 'local followers', { visibility: 'followers' });
		const direct = await post(site, author, 'direct recipient', { visibility: 'specified', visibleUserIds: [follower.id] });
		const ownerOnly = await post(site, author, 'local owner only', { visibility: 'specified', visibleUserIds: [author.id] });
		const peerFollowers = await post(peer, peer.author, 'peer followers', { visibility: 'followers', localOnly: false });
		const peerDirect = await post(peer, peer.author, 'peer direct recipient', { visibility: 'specified', visibleUserIds: [remoteFollower.id], localOnly: false });
		const peerOwnerOnly = await post(peer, peer.author, 'peer owner only', { visibility: 'specified', visibleUserIds: [peer.author.id] });
		const undelivered = await post(peer, peer.author, 'undelivered peer followers', { visibility: 'followers' });
		await eventually('private ActivityPub deliveries cached', async () => (await site.db.query('SELECT id FROM note WHERE uri = ANY($1)', [[canonical(peer, peerFollowers), canonical(peer, peerDirect)]])).rowCount === 2);
		const peerChannel = await api(peer, 'channels/create', { name: `Peer ${suffix}` }, peer.author.token);
		const peerChannelNote = await post(peer, peer.author, 'peer channel', { channelId: peerChannel.id });
		const channel = await api(site, 'channels/create', { name: `Local ${suffix}` }, author.token);
		const channelNote = await post(site, author, 'local channel', { channelId: channel.id });
		const sensitive = await api(site, 'channels/create', { name: `Sensitive ${suffix}`, isSensitive: true }, author.token);
		const sensitiveNote = await post(site, author, 'sensitive channel', { channelId: sensitive.id });
		const channelQuote = await post(site, author, 'channel quote', { renoteId: channelNote.id });
		await post(site, author, 'local public');
		await post(peer, peer.author, 'peer public');

		const visible = await collect(site, author, follower.token, { limit: 3 });
		for (const note of [localFollowers, direct, channelNote, channelQuote]) assertReadable(visible.find(n => n.id === note.id), note);
		for (const note of [peerFollowers, peerDirect]) assertReadable(visible.find(n => n.uri === canonical(peer, note)), note);
		assert.ok(!contains(visible, site, ownerOnly));
		assert.ok(!contains(visible, site, sensitiveNote));
		for (const note of [peerOwnerOnly, undelivered, peerChannelNote]) {
			assert.ok(!visible.some(n => n.uri === canonical(peer, note)));
			assert.equal((await site.db.query('SELECT id FROM note WHERE uri=$1', [canonical(peer, note)])).rowCount, 0, 'history must not fetch private peer notes');
		}
		const ownerView = await collect(site, author, author.token);
		assertReadable(ownerView.find(n => n.id === ownerOnly.id), ownerOnly);
		assertReadable(ownerView.find(n => n.id === localFollowers.id), localFollowers);
		assertReadable(ownerView.find(n => n.id === sensitiveNote.id), sensitiveNote);
		assert.ok(!ownerView.some(n => n.uri === canonical(peer, peerOwnerOnly)), 'link grants no counterpart identity');
		const remoteView = await collect(site, remote, follower.token);
		assert.deepEqual(new Set(remoteView.map(n => canonical(site, n))), new Set(visible.map(n => canonical(site, n))));
		for (const token of [outsider.token, undefined]) {
			const notes = await collect(site, author, token);
			assert.ok(notes.every(n => n.visibility === 'public' || n.visibility === 'home'));
			assert.ok(!contains(notes, site, sensitiveNote));
		}
		const withoutChannels = await collect(site, author, follower.token, { withChannelNotes: false });
		assert.ok(withoutChannels.every(n => n.channel == null));
		assert.ok(contains(withoutChannels, site, direct));
		console.log(`${site.role}: owner/follower/recipient/outsider/anonymous permissions, both profiles and channels PASS`);

		await api(site, 'channels/mute/create', { channelId: channel.id }, follower.token);
		const channelMuted = await collect(site, author, follower.token);
		assert.ok(!contains(channelMuted, site, channelNote));
		assert.ok(!contains(channelMuted, site, channelQuote));
		await site.db.query('UPDATE channel_muting SET "expiresAt"=CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "userId"=$1 AND "channelId"=$2', [follower.id, channel.id]);
		assert.ok(contains(await collect(site, author, follower.token), site, channelNote), 'expired channel mute no longer filters notes');
		await api(site, 'channels/mute/delete', { channelId: channel.id }, follower.token);
		await api(site, 'mute/create', { userId: remote.id }, follower.token);
		assert.ok((await collect(site, author, follower.token)).every(n => n.userId !== remote.id));
		await api(site, 'mute/delete', { userId: remote.id }, follower.token);

		const first = await api(site, 'gridspace/history', { userId: author.id, limit: 1 }, follower.token);
		assert.ok(first.cursor);
		await assert.rejects(api(site, 'gridspace/history', { userId: author.id, withChannelNotes: false, cursor: first.cursor }, follower.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
		await assert.rejects(api(site, 'gridspace/history', { userId: author.id, cursor: first.cursor }, outsider.token), x => x.code === 'GRIDSPACE_HISTORY_UNAVAILABLE');
		await api(site, 'following/delete', { userId: author.id }, follower.token);
		await api(site, 'following/delete', { userId: remote.id }, follower.token);
		const afterUnfollow = await collect(site, author, follower.token, {}, await api(site, 'gridspace/history', { userId: author.id, cursor: first.cursor }, follower.token));
		assert.ok(!contains(afterUnfollow, site, localFollowers));
		assert.ok(!afterUnfollow.some(n => n.uri === canonical(peer, peerFollowers)));
		assertReadable(afterUnfollow.find(n => n.id === direct.id), direct);
		assertReadable(afterUnfollow.find(n => n.uri === canonical(peer, peerDirect)), peerDirect);
		await api(site, 'blocking/create', { userId: follower.id }, author.token);
		assert.ok((await collect(site, author, follower.token)).every(n => n.userId !== author.id));
		await api(site, 'blocking/delete', { userId: follower.id }, author.token);
		await api(site, 'blocking/create', { userId: remote.id }, follower.token);
		assert.ok((await collect(site, author, follower.token)).every(n => n.userId !== remote.id));
		await api(site, 'blocking/delete', { userId: remote.id }, follower.token);

		await api(site, 'i/update', { isLocked: true }, author.token);
		await api(site, 'following/create', { userId: author.id }, outsider.token);
		assert.equal((await api(site, 'users/show', { userId: author.id }, outsider.token)).hasPendingFollowRequestFromYou, true);
		assert.ok(!contains(await collect(site, author, outsider.token), site, localFollowers), 'pending request gives no access');
		await api(site, 'i/update', { isLocked: false }, author.token);
		for (const note of [localFollowers, direct, ownerOnly, channelNote, sensitiveNote]) {
			assert.equal((await peer.db.query('SELECT id FROM note WHERE uri=$1', [canonical(site, note)])).rowCount, 0);
			assert.equal((await e.db.query('SELECT id FROM note WHERE uri=$1', [canonical(site, note)])).rowCount, 0);
		}
		console.log(`${site.role}: current permissions on pagination, cursor binding, user/channel mutes, blocks, pending follows and no private replication PASS`);
	}
} finally {
	for (const site of [g, r, e]) {
		if (site.visitorPolicy !== undefined) await api(site, 'admin/update-meta', { ugcVisibilityForVisitor: site.visitorPolicy }, site.admin.token);
		await site.db?.end();
	}
}
