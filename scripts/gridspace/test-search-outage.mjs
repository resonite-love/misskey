/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, loadSite, savePrivateJson, eventually } from './lab.mjs';

const site = loadSite('.', 0);
const accounts = JSON.parse(readFileSync('.config/gridspace-search-test-accounts.json', 'utf8'));
const args = { query: accounts.query, limit: 3 };
const token = accounts.viewer.token;
const path = '.config/search-outage-position.json';
if (process.argv[2] === 'prepare') {
	const first = await api(site, 'gridspace/search', args, token);
	const expected = await api(site, 'gridspace/search', { ...args, cursor: first.cursor }, token);
	assert.equal(first.peerAvailable, true);
	savePrivateJson(path, { cursor: first.cursor, ids: expected.notes.map(note => note.id) });
	console.log('Saved search continuation before peer outage');
} else if (process.argv[2] === 'during') {
	const saved = JSON.parse(readFileSync(path, 'utf8'));
	const partial = await api(site, 'gridspace/search', { ...args, cursor: saved.cursor }, token);
	assert.equal(partial.peerAvailable, false);
	assert.equal(partial.cursor, saved.cursor);
	assert.ok(partial.notes.length > 0 && partial.notes.every(note => note.user.host == null));
	const people = await api(site, 'gridspace/search', { query: accounts.grid.username, kind: 'users' }, token);
	assert.equal(people.peerAvailable, false);
	assert.equal(people.users.length, 1);
	assert.equal(people.users[0].linkedAccounts.length, 0);
	console.log('Peer down: local note/people previews, no unverified link and unchanged cursor PASS');
} else if (process.argv[2] === 'after') {
	const saved = JSON.parse(readFileSync(path, 'utf8'));
	await eventually('peer search recovery', async () => {
		try { return (await api(site, 'gridspace/search', args, token)).peerAvailable; } catch { return false; }
	}, 30000);
	const page = await api(site, 'gridspace/search', { ...args, cursor: saved.cursor }, token);
	assert.equal(page.peerAvailable, true);
	assert.deepEqual(page.notes.map(note => note.id), saved.ids);
	console.log('Peer recovered: same cursor resumes without gaps PASS');
} else {
	throw new Error('Use prepare, during (with R stopped), or after (with R restarted).');
}
