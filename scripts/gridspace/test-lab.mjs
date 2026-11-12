/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api, eventually, loadSite } from './lab.mjs';

const [peerRepo, externalRepo] = process.argv.slice(2);
if (!peerRepo || !externalRepo) throw new Error('Usage: node scripts/gridspace/test-lab.mjs <resonite-repository> <external-repository>');
const labs = [fileURLToPath(new URL('../../', import.meta.url)), peerRepo, externalRepo].map(loadSite).map(site => {
	const state = JSON.parse(readFileSync(site.accountsPath, 'utf8'));
	assert.equal(state.origin, site.origin);
	return { ...site, accounts: state.accounts };
});
const run = randomUUID();
const request = (site, account, endpoint, params = {}) => api(site, endpoint, params, site.accounts[account].token);
const post = (site, visibility, params = {}, account = 'author') => request(site, account, 'notes/create', { text: `GridSpace lab ${run} ${visibility}`, visibility, ...params }).then(result => result.createdNote);
const remote = (site, other, account = 'author', viewer = 'reader') => request(site, viewer, 'users/show', { username: other.accounts[account].username, host: new URL(other.origin).host });

for (const site of labs) {
	for (const path of ['/', '/healthz']) {
		const response = await fetch(`${site.origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
		assert.equal(response.status, 200, `${site.role} ${path}`);
	}
	const meta = await api(site, 'meta');
	assert.equal(meta.name, site.name);
	assert.equal(meta.disableRegistration, true);
	const socket = new WebSocket(`${site.origin.replace('https:', 'wss:')}/streaming?i=${encodeURIComponent(site.accounts.reader.token)}`);
	const messages = [];
	let failed = false;
	socket.addEventListener('error', () => { failed = true; });
	socket.addEventListener('message', event => { messages.push(JSON.parse(event.data)); });
	try {
		await eventually(`${site.role} WebSocket open`, () => {
			assert.equal(failed, false, 'WebSocket failed');
			return socket.readyState === WebSocket.OPEN;
		});
		socket.send(JSON.stringify({ type: 'connect', body: { channel: 'localTimeline', id: run, pong: true } }));
		await eventually(`${site.role} channel connected`, () => messages.some(message => message.type === 'connected' && message.body.id === run));
		const note = await post(site, 'public', { localOnly: true });
		await eventually(`${site.role} live local note`, () => messages.some(message => message.type === 'channel' && message.body.type === 'note' && message.body.body.id === note.id));
	} finally {
		socket.close();
	}
	console.log(`${site.role}: HTTPS / closed registration / WebSocket live local timeline PASS`);
}

// Establish every directed edge before posting. This also tests ordinary, unmodified E.
for (const source of labs) {
	for (const target of labs.filter(site => site !== source)) {
		const actor = await remote(target, source);
		if (!actor.isFollowing && !actor.hasPendingFollowRequestFromYou) {
			await request(target, 'reader', 'following/create', { userId: actor.id });
		}
		await eventually(`${target.role} follows ${source.role}`, async () => (await remote(target, source)).isFollowing);
		await eventually(`${source.role} received ${target.role} follow`, async () => (await remote(source, target, 'reader', 'author')).isFollowed);
	}
}

for (const source of labs) {
	const notes = [];
	for (const visibility of ['public', 'home', 'followers']) notes.push(await post(source, visibility));
	const local = await post(source, 'public', { localOnly: true, text: `GridSpace lab ${run} local-only` });
	for (const target of labs.filter(site => site !== source)) {
		const actor = await remote(target, source);
		await eventually(`${source.role} -> ${target.role} visibility delivery`, async () => {
			const timeline = await request(target, 'reader', 'notes/timeline', { limit: 100 });
			return notes.every(note => timeline.some(item => item.uri === `${source.origin}/notes/${note.id}` && item.text === note.text));
		});
		const history = await request(target, 'reader', 'users/notes', { userId: actor.id, limit: 100 });
		assert.equal(history.some(note => note.uri === `${source.origin}/notes/${local.id}`), false, 'Local-only note was federated');
		const localTimeline = await request(target, 'reader', 'notes/local-timeline', { limit: 100 });
		assert.equal(localTimeline.some(note => notes.some(original => original.visibility === 'home' && note.uri === `${source.origin}/notes/${original.id}`)), false, 'Home note appeared in the local timeline');
		console.log(`${source.role} -> ${target.role}: public / home / followers delivery; local-only exclusion PASS`);
	}
}

// E must never learn local-only content, even when it explicitly resolves a note URI.
for (const source of labs.slice(0, 2)) {
	const local = await post(source, 'public', { localOnly: true });
	const uri = `${source.origin}/notes/${local.id}`;
	const response = await fetch(uri, { headers: { accept: 'application/activity+json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 404, 'Local-only note was served as ActivityPub');
	await assert.rejects(request(labs[2], 'reader', 'ap/show', { uri }), error => error.code === 'REQUEST_FAILED');
}

const [grid, resonite] = labs;
const locked = await remote(grid, resonite, 'locked');
if (locked.isFollowing || locked.hasPendingFollowRequestFromYou) await request(grid, 'reader', 'following/delete', { userId: locked.id });
await eventually('Previous locked follow removed', async () => !(await remote(resonite, grid, 'reader', 'locked')).isFollowed);
await request(grid, 'reader', 'following/create', { userId: locked.id });
await eventually('Locked follow pending', async () => (await remote(grid, resonite, 'locked')).hasPendingFollowRequestFromYou);
assert.equal((await remote(grid, resonite, 'locked')).isFollowing, false, 'Locked follow was accepted without approval');
const follower = await remote(resonite, grid, 'reader', 'locked');
await eventually('Locked follow request delivered', async () => (await remote(resonite, grid, 'reader', 'locked')).hasPendingFollowRequestToYou);
await request(resonite, 'locked', 'following/requests/accept', { userId: follower.id });
await eventually('Locked follow accepted', async () => (await remote(grid, resonite, 'locked')).isFollowing);
const restricted = await post(resonite, 'followers', {}, 'locked');
await eventually('Locked follower note delivered', async () => (await request(grid, 'reader', 'notes/timeline', { limit: 100 })).some(note => note.uri === `${resonite.origin}/notes/${restricted.id}`));
const notifications = await request(resonite, 'locked', 'i/notifications', { limit: 100, markAsRead: false });
assert.ok(notifications.some(notification => notification.type === 'receiveFollowRequest' || notification.type === 'follow'));
console.log('G <-> R: locked follow requires approval / follower note / notification PASS');
console.log('All baseline checks passed. Account linking and shared timelines are not covered by this baseline.');
