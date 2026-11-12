/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { api, loadSite, savePrivateJson } from './lab.mjs';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const { Client } = createRequire(resolve('packages/backend/package.json'))('pg');
const suffix = randomBytes(5).toString('hex');
const roles = new Map();
for (const site of [g, r]) {
	site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
	const password = readFileSync(resolve(site.repo, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
	site.db = new Client({ host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password, database: site.config.db.db });
	await site.db.connect();
}
async function account(site, label) {
	const password = randomBytes(24).toString('base64url');
	return { ...await api(site, 'admin/accounts/create', { username: `ch_${label}_${suffix}`, password }, site.accounts.admin.token), password };
}
async function consent(grid, resonite) {
	const started = await api(g, 'gridspace/link', { action: 'start' }, grid.token);
	assert.ok(new URL(started.authorizationUrl).searchParams.get('scope').split(' ').includes('write:gridspace-channel'));
	const response = await fetch(started.authorizationUrl);
	const transaction = (await response.text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];
	assert.ok(transaction);
	const decision = await fetch(`${r.origin}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction_id: transaction, login_token: resonite.token }) });
	assert.equal(decision.status, 302);
	const callback = new URL(decision.headers.get('location'));
	await api(g, 'gridspace/link', { action: 'finish', code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), issuer: callback.searchParams.get('iss'), clientKey: started.clientKey }, grid.token);
}
const denied = promise => assert.rejects(promise, error => /GRIDSPACE_|PERMISSION_DENIED|ACCESS_DENIED|INVALID_PARAM|CREDENTIAL_REQUIRED/.test(error.code));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNw2BL1nxLMMGrA/9EwiBoNgy3DIgwAwJVNH4qw1v8AAAAASUVORK5CYII=', 'base64');
async function upload(site, endpoint, user, extra = {}) {
	const form = new FormData(); form.set('i', user.token); form.set('file', new Blob([png], { type: 'image/png' }), 'channel.png');
	for (const [key, value] of Object.entries(extra)) form.set(key, String(value));
	const response = await fetch(`${site.origin}/api/${endpoint}`, { method: 'POST', body: form });
	const result = await response.json();
	if (!response.ok) throw Object.assign(new Error(result.error?.code), { code: result.error?.code });
	return result;
}
try {
	const grid = await account(g, 'g'); const resonite = await account(r, 'r'); const author = await account(r, 'a');
	for (const [site, users] of [[g, [grid]], [r, [resonite, author]]]) {
		const role = await api(site, 'admin/roles/create', { name: `Channels ${suffix}`, description: 'Temporary test role', color: null, iconUrl: null, target: 'manual', condFormula: {}, isPublic: false, isModerator: false, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: { rateLimitFactor: { useDefault: false, priority: 2, value: 0 }, canSearchNotes: { useDefault: false, priority: 2, value: true } } }, site.accounts.admin.token);
		roles.set(site, role.id);
		for (const user of users) await api(site, 'admin/roles/assign', { roleId: role.id, userId: user.id }, site.accounts.admin.token);
	}
	await consent(grid, resonite);
	assert.equal((await api(g, 'gridspace/private-grant', {}, grid.token)).canWriteChannels, true);
	assert.equal((await api(r, 'gridspace/private-grant', {}, resonite.token)).canWriteChannels, false);
	const channel = await api(r, 'channels/create', { name: `Channel ${suffix}`, description: 'Channel description', allowRenoteToExternal: false }, author.token);
	const sensitive = await api(r, 'channels/create', { name: `Sensitive ${suffix}`, isSensitive: true }, author.token);
	const other = await api(r, 'channels/create', { name: `Other ${suffix}` }, author.token);
	await api(r, 'channels/follow', { channelId: channel.id }, resonite.token);
	const list = options => api(g, 'gridspace/channels', options, grid.token);
	const first = await list({ query: suffix, limit: 2 });
	assert.equal(first.channels.length, 2); assert.ok(first.next);
	const second = await list({ query: suffix, limit: 2, before: first.next });
	assert.equal(second.channels.length, 1); assert.equal(second.next, null);
	assert.equal(new Set([...first.channels, ...second.channels].map(c => c.id)).size, 3);
	assert.deepEqual((await list({ followed: true })).channels.map(c => c.id), [channel.id]);
	await api(r, 'channels/mute/create', { channelId: channel.id }, resonite.token);
	assert.equal((await list({ followed: true })).channels.length, 0);
	assert.equal((await list({ channelId: channel.id })).channels[0].name, channel.name);
	const sourcePost = async (channelId, text, extra = {}) => (await api(r, 'notes/create', { channelId, text, ...extra }, author.token)).createdNote;
	const parent = await sourcePost(channel.id, `Channel body ${suffix}`, { poll: { choices: ['yes', 'no'], multiple: false } });
	const secret = await sourcePost(sensitive.id, `Sensitive body ${suffix}`);
	const otherNote = await sourcePost(other.id, `Other body ${suffix}`);
	const timeline = options => api(g, 'gridspace/private-notes', { mode: 'channel', channelId: channel.id, ...options }, grid.token);
	assert.equal((await timeline({})).notes[0].id, parent.id, 'Explicitly opened channel ignores its channel mute');
	assert.equal((await timeline({ channelId: sensitive.id })).notes[0].id, secret.id);
	assert.equal((await timeline({ mode: 'show', noteId: otherNote.id })).notes.length, 0);
	assert.equal((await timeline({ mode: 'validate', contextMode: 'channel', ids: [parent.id, otherNote.id] })).notes.length, 1);
	await api(r, 'channels/mute/delete', { channelId: channel.id }, resonite.token);
	await api(r, 'channels/favorite', { channelId: channel.id }, resonite.token);
	assert.deepEqual((await list({ list: 'following', query: suffix })).channels.map(c => c.id), [channel.id]);
	assert.deepEqual((await list({ list: 'favorites', query: suffix })).channels.map(c => c.id), [channel.id]);
	assert.equal((await list({ list: 'owned', query: suffix })).channels.length, 0);
	assert.ok(!(await list({ query: 'Channel description', queryType: 'nameOnly' })).channels.some(c => c.id === channel.id));
	assert.ok((await list({ query: 'Channel description', queryType: 'nameAndDescription' })).channels.some(c => c.id === channel.id));
	const featured = await list({ list: 'featured', query: suffix });
	assert.equal(featured.next, null);
	assert.ok(featured.channels.every(c => c.lastNotedAt && c.createdAt && typeof c.usersCount === 'number'));
	assert.deepEqual(featured.channels.map(c => c.lastNotedAt), featured.channels.map(c => c.lastNotedAt).sort().reverse());
	console.log('Channel list, stable pagination, source follows/mutes, explicit sensitive access and context validation PASS');

	const post = options => api(g, 'gridspace/channel-post', { channelId: channel.id, ...options }, grid.token);
	const prepared = await post({});
	assert.equal(prepared.account.username, resonite.username); assert.equal(prepared.visibility, 'public'); assert.equal(prepared.localOnly, true);
	const file = await upload(g, 'gridspace/private-upload', grid, { channelId: channel.id, name: 'channel.png', comment: 'channel alt' });
	assert.equal((await r.db.query('SELECT "userId" FROM drive_file WHERE id=$1', [file.id])).rows[0].userId, resonite.id);
	const request = { action: 'send', requestId: randomUUID(), text: `Posted from G ${suffix}`, cw: 'channel CW', fileIds: [file.id] };
	const results = await Promise.all([post(request), post(request)]);
	assert.equal(results[0].createdNoteId, results[1].createdNoteId);
	const createdId = results[0].createdNoteId;
	const created = await api(r, 'notes/show', { noteId: createdId }, resonite.token);
	assert.equal(created.userId, resonite.id); assert.equal(created.channel.id, channel.id); assert.equal(created.localOnly, true); assert.equal(created.cw, 'channel CW');
	assert.equal((await r.db.query('SELECT count(*)::int AS n FROM note WHERE text=$1', [request.text])).rows[0].n, 1);
	assert.equal((await post({ action: 'status', requestId: request.requestId })).createdNoteId, createdId);
	await denied(post({ ...request, text: 'Conflicting body' }));
	const reply = await post({ action: 'send', noteId: parent.id, requestId: randomUUID(), text: `Channel reply ${suffix}` });
	assert.equal((await api(r, 'notes/show', { noteId: reply.createdNoteId }, resonite.token)).replyId, parent.id);
	await denied(post({ action: 'send', noteId: otherNote.id, requestId: randomUUID(), text: 'Wrong channel' }));
	await denied(api(g, 'gridspace/private-reply', { noteId: parent.id, action: 'send', requestId: randomUUID(), text: 'Wrong endpoint' }, grid.token));
	const bytes = await api(g, 'gridspace/private-file', { noteId: createdId, channelId: channel.id, fileId: file.id }, grid.token);
	assert.deepEqual(Buffer.from(bytes.data, 'base64'), png);
	assert.equal((await g.db.query('SELECT count(*)::int AS n FROM note WHERE uri=$1', [`${r.origin}/notes/${createdId}`])).rows[0].n, 0);
	assert.ok(!(await api(r, 'notes/local-timeline', {}, resonite.token)).some(note => note.id === createdId));
	console.log('Old identity, source-owned attachment, CW, same-channel reply, atomic retry receipt, no copy/LTL leakage PASS');

	const action = options => api(g, 'gridspace/private-action', { noteId: parent.id, channelId: channel.id, ...options }, grid.token);
	await action({ action: 'add-reaction', reaction: '👍' }); await action({ action: 'add-reaction', reaction: '🎉' });
	assert.deepEqual(new Set((await action({})).note.myReactions), new Set(['👍', '🎉']));
	await action({ action: 'remove-reaction', reaction: '🎉' });
	assert.deepEqual((await action({})).note.myReactions, ['👍']);
	assert.equal((await action({ action: 'reaction-list', reaction: '👍' })).reactors[0].account.username, resonite.username);
	await action({ action: 'vote', choice: 0 });
	assert.equal((await action({})).note.poll.choices[0].isVoted, true);
	console.log('Source-owned multiple reactions, exact extra removal, reactor list and vote PASS');

	await api(r, 'mute/create', { userId: author.id }, resonite.token);
	assert.ok(!(await timeline({})).notes.some(note => note.id === parent.id));
	await api(r, 'mute/delete', { userId: author.id }, resonite.token);
	await api(r, 'blocking/create', { userId: resonite.id }, author.token);
	assert.ok(!(await timeline({})).notes.some(note => note.id === parent.id));
	await denied(post({ action: 'send', noteId: parent.id, requestId: randomUUID(), text: 'Blocked reply' }));
	await api(r, 'blocking/delete', { userId: resonite.id }, author.token);
	const authorOnGrid = await api(g, 'users/show', { username: author.username, host: new URL(r.origin).host }, grid.token);
	await api(g, 'mute/create', { userId: authorOnGrid.id }, grid.token);
	assert.ok(!(await timeline({})).notes.some(note => note.id === parent.id));
	await api(g, 'mute/delete', { userId: authorOnGrid.id }, grid.token);
	await api(r, 'channels/update', { channelId: channel.id, isArchived: true }, author.token);
	assert.ok((await list({ list: 'favorites', query: suffix })).channels.some(c => c.id === channel.id));
	assert.ok((await list({ list: 'following', query: suffix })).channels.some(c => c.id === channel.id));
	assert.ok(!(await list({ list: 'featured', query: suffix })).channels.some(c => c.id === channel.id));
	assert.equal((await post({})).canReply, false);
	await denied(post({ action: 'send', requestId: randomUUID(), text: 'Archived' }));
	await denied(upload(g, 'gridspace/private-upload', grid, { channelId: channel.id, name: 'archive.png' }));
	assert.ok((await timeline({})).notes.some(note => note.id === createdId));
	await api(r, 'channels/update', { channelId: channel.id, isArchived: false }, author.token);
	console.log('Both-account mute/block enforcement and archive read-only behavior PASS');

	const gridChannel = await api(g, 'channels/create', { name: `G only ${suffix}` }, grid.token);
	await api(g, 'channels/favorite', { channelId: gridChannel.id }, grid.token);
	const ownedChannel = await api(r, 'channels/create', { name: `Owned ${suffix}` }, resonite.token);
	assert.deepEqual((await list({ list: 'owned', query: suffix })).channels.map(c => [c.id, c.isOwned]), [[ownedChannel.id, true]]);
	const gridFile = await upload(g, 'drive/files/create', grid);
	const gridNote = (await api(g, 'notes/create', { channelId: gridChannel.id, text: 'Reverse prohibited', fileIds: [gridFile.id] }, grid.token)).createdNote;
	await denied(api(r, 'gridspace/channels', {}, resonite.token));
	await denied(api(r, 'gridspace/private-notes', { mode: 'channel', channelId: gridChannel.id }, resonite.token));
	assert.equal((await api(r, 'gridspace/private-notes', { mode: 'show', noteId: gridNote.id }, resonite.token)).notes.length, 0);
	assert.equal((await api(r, 'gridspace/private-notes', { mode: 'validate', contextMode: 'show', ids: [gridNote.id] }, resonite.token)).notes.length, 0);
	await denied(api(r, 'gridspace/private-file', { noteId: gridNote.id, fileId: gridFile.id }, resonite.token));
	await denied(api(r, 'gridspace/channel-post', { channelId: gridChannel.id, action: 'send', requestId: randomUUID(), text: 'Reverse prohibited' }, resonite.token));
	const weak = await api(g, 'miauth/gen-token', { session: null, permission: ['write:gridspace-reply'], name: 'legacy-reply-only' }, grid.token);
	await denied(api(g, 'gridspace/channel-post', { channelId: channel.id }, weak.token));
	await api(g, 'gridspace/private-grant', { action: 'revoke' }, grid.token);
	await denied(list({})); await denied(timeline({})); await denied(post({ action: 'send', requestId: randomUUID(), text: 'Revoked' }));
	await consent(grid, resonite);
	savePrivateJson(resolve('.config/gridspace-channels-test-accounts.json'), { grid, resonite, author, channel, sensitive, parent, secret, createdId, suffix, gridChannel, ownedChannel });
	console.log('Reverse direction denied even without channelId; scope isolation, revoke and reauthorization PASS');
} finally {
	for (const [site, roleId] of roles) await api(site, 'admin/roles/delete', { roleId }, site.accounts.admin.token).catch(() => {});
	for (const site of [g, r]) await site.db.end();
}
