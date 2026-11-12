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
import { createGridspaceHeaders, resolveGridspaceConfig } from '../../packages/backend/src/core/gridspace/peer-protocol.ts';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const fixture = JSON.parse(readFileSync('.config/gridspace-channels-test-accounts.json', 'utf8'));
for (const site of [g, r]) site.accounts = JSON.parse(readFileSync(site.accountsPath, 'utf8')).accounts;
const suffix = randomBytes(5).toString('hex');
const password = randomBytes(24).toString('base64url');
const guest = { ...await api(g, 'admin/accounts/create', { username: `guest_${suffix}`, password }, g.accounts.admin.token), password };
const other = await api(g, 'admin/accounts/create', { username: `guestx_${suffix}`, password: randomBytes(24).toString('base64url') }, g.accounts.admin.token);
const channelId = fixture.channel.id;
const notes = options => api(g, 'gridspace/private-notes', { mode: 'channel', channelId, ...options }, guest.token);
const post = options => api(g, 'gridspace/channel-post', { channelId, ...options }, guest.token);
const action = options => api(g, 'gridspace/private-action', { channelId, noteId: fixture.parent.id, ...options }, guest.token);
const denied = promise => assert.rejects(promise, error => /GRIDSPACE_|PERMISSION_DENIED|ACCESS_DENIED|AUTHENTICATION_FAILED|YOU_HAVE_BEEN_SUSPENDED/.test(error.code));
assert.equal((await api(g, 'gridspace/link', {}, guest.token)).state, 'unlinked');
assert.equal((await api(g, 'gridspace/link', {}, guest.token)).channelsEnabled, true);
assert.ok((await api(g, 'gridspace/channels', { channelId }, guest.token)).channels.length);
assert.ok((await notes({ mode: 'show', noteId: fixture.parent.id })).notes.some(note => note.id === fixture.parent.id));
assert.equal((await notes({ channelId: fixture.sensitive.id })).notes[0].id, fixture.secret.id);
const prepared = await post({});
assert.equal(prepared.account.uri, `${g.origin}/users/${guest.id}`);
assert.equal(prepared.account.host, new URL(g.origin).host);
assert.equal(prepared.canReply, true);
const targetUser = await api(r, 'users/show', { username: guest.username, host: new URL(g.origin).host }, fixture.resonite.token);
const text = `Guest post ${suffix}`;
const input = { action: 'send', requestId: randomUUID(), text, expectedActorUri: prepared.account.uri };
const posted = await post(input);
assert.equal((await post(input)).createdNoteId, posted.createdNoteId);
const source = await api(r, 'notes/show', { noteId: posted.createdNoteId }, fixture.resonite.token);
assert.equal(source.userId, targetUser.id); assert.equal(source.user.host, new URL(g.origin).host);
assert.equal(source.localOnly, true); assert.equal(source.channel.id, channelId);
assert.equal((await fetch(`${r.origin}/notes/${posted.createdNoteId}`, { headers: { accept: 'application/activity+json' } })).status, 404);
await denied(post({ ...input, requestId: randomUUID(), expectedActorUri: `${g.origin}/users/${other.id}` }));
await denied(api(g, 'gridspace/private-notes', { mode: 'home' }, guest.token));
assert.equal((await notes({ mode: 'show', noteId: posted.createdNoteId })).notes.find(note => note.id === posted.createdNoteId).canDelete, true);
console.log('Unlinked member reads channels and posts as the actual G account; identity mismatch rejected PASS');
const pollRequest = { action: 'send', requestId: randomUUID(), expectedActorUri: prepared.account.uri, poll: { choices: ['Guest A', 'Guest B'], multiple: false, expiresAt: null } };
const pollId = (await post(pollRequest)).createdNoteId;
assert.equal((await post(pollRequest)).createdNoteId, pollId);
const pollNote = await api(r, 'notes/show', { noteId: pollId }, fixture.resonite.token);
assert.equal(pollNote.userId, targetUser.id);
assert.deepEqual(pollNote.poll.choices.map(choice => choice.text), pollRequest.poll.choices);
console.log('Unlinked member creates a poll-only note as the G identity and retries without duplication PASS');

await post({ action: 'send', requestId: randomUUID(), noteId: fixture.parent.id, text: `Guest reply ${suffix}` });
await action({ action: 'add-reaction', reaction: '👍' }); await action({ action: 'add-reaction', reaction: '🎉' });
assert.deepEqual(new Set((await action({})).note.myReactions), new Set(['👍', '🎉']));
await action({ action: 'remove-reaction', reaction: '🎉' });
assert.deepEqual((await action({})).note.myReactions, ['👍']);
await denied(action({ action: 'add-reaction', reaction: '😆', expectedActorUri: `${g.origin}/users/${other.id}` }));
await action({ action: 'vote', choice: 1 });
assert.equal((await action({})).note.poll.choices[1].isVoted, true);
const form = new FormData(); form.set('i', guest.token); form.set('channelId', channelId); form.set('name', 'guest.txt'); form.set('file', new Blob(['guest attachment'], { type: 'text/plain' }), 'guest.txt');
const uploaded = await fetch(`${g.origin}/api/gridspace/private-upload`, { method: 'POST', body: form });
assert.equal(uploaded.status, 200); const file = await uploaded.json();
const { Client } = createRequire(new URL('../../packages/backend/package.json', import.meta.url))('pg');
const sourceDb = new Client({ host: r.config.db.host, port: r.config.db.port, user: r.config.db.user, password: r.config.db.pass, database: r.config.db.db });
let sourceFile;
try {
	await sourceDb.connect();
	sourceFile = (await sourceDb.query('SELECT "isLink", size, url, uri FROM drive_file WHERE id = $1', [file.id])).rows[0];
} finally { await sourceDb.end(); }
assert.equal(sourceFile.isLink, true); assert.equal(Number(sourceFile.size), 0);
assert.equal(sourceFile.uri, sourceFile.url);
const ownFiles = await api(g, 'drive/files', { limit: 100 }, guest.token);
assert.ok(ownFiles.some(original => original.url === sourceFile.url && original.size > 0));
const attachment = await post({ action: 'send', requestId: randomUUID(), text: `Guest attachment ${suffix}`, fileIds: [file.id] });
const bytes = await api(g, 'gridspace/private-file', { channelId, noteId: attachment.createdNoteId, fileId: file.id }, guest.token);
assert.equal(Buffer.from(bytes.data, 'base64').toString(), 'guest attachment');
await denied(api(g, 'gridspace/channel-post', { channelId, action: 'send', requestId: randomUUID(), text: 'Steal attachment', fileIds: [file.id] }, other.token));
console.log('Guest reply, multiple reactions, exact removal, vote, own attachment and cross-user file denial PASS');

await api(r, 'blocking/create', { userId: targetUser.id }, fixture.author.token);
assert.ok(!(await notes({ mode: 'show', noteId: fixture.parent.id })).notes.some(note => note.id === fixture.parent.id));
await denied(post({ action: 'send', requestId: randomUUID(), noteId: fixture.parent.id, text: 'Blocked reply' }));
await api(r, 'blocking/delete', { userId: targetUser.id }, fixture.author.token);
await api(r, 'admin/suspend-user', { userId: targetUser.id }, r.accounts.admin.token);
await denied(notes({})); await denied(post({ action: 'send', requestId: randomUUID(), text: 'Suspended source' }));
await api(r, 'admin/unsuspend-user', { userId: targetUser.id }, r.accounts.admin.token);
await denied(api(g, 'gridspace/channel-delete', { channelId, noteId: posted.createdNoteId, asCurrentAccount: true }, other.token));
await api(g, 'gridspace/channel-delete', { channelId, noteId: posted.createdNoteId, asCurrentAccount: true }, guest.token);
await api(g, 'gridspace/channel-delete', { channelId, noteId: posted.createdNoteId, asCurrentAccount: true }, guest.token);
assert.ok(!(await notes({ mode: 'show', noteId: posted.createdNoteId })).notes.some(note => note.id === posted.createdNoteId));
await api(r, 'notes/delete', { noteId: attachment.createdNoteId }, r.accounts.admin.token);
assert.ok(!(await notes({})).notes.some(note => note.id === attachment.createdNoteId));
console.log('Source block, suspension, owner-only idempotent deletion and source moderator deletion PASS');

const env = Object.fromEntries(readFileSync(resolve(g.repo, '.config/gridspace-lab.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const peer = resolveGridspaceConfig(g.config.gridspace, g.origin, env);
for (const payload of [{ mode: 'home', channelActorId: guest.id }, { mode: 'show', channelActorId: guest.id, noteId: fixture.parent.id }, { mode: 'show', channelActorId: guest.id, channelId, noteId: fixture.secret.id }]) {
	const path = '/gridspace/v1/private/notes'; const body = Buffer.from(JSON.stringify(payload));
	const response = await fetch(r.origin + path, { method: 'POST', body, headers: createGridspaceHeaders(peer, 'POST', path, body) });
	if (payload.channelId) { assert.equal(response.status, 200); assert.equal((await response.json()).notes.length, 0); }
	else assert.equal(response.status, 403);
}
const path = '/gridspace/v1/private/channels'; const body = Buffer.from(JSON.stringify({ channelActorId: guest.id }));
assert.equal((await fetch(r.origin + path, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 403);
assert.equal((await api(g, 'gridspace/link', {}, guest.token)).state, 'unlinked');
savePrivateJson(resolve('.config/gridspace-channel-guest.json'), { guest, other, targetUserId: targetUser.id });
console.log('Unsigned requests and non-channel private reads rejected; no implicit account linkage PASS');
