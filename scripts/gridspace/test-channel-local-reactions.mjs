/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, loadSite } from './lab.mjs';
import { makeProfileAccount } from './test-profile-import.mjs';

const g = loadSite('.', 0); const r = loadSite('../resonite-love-gridspace', 1);
const grid = await makeProfileAccount(g); const source = await makeProfileAccount(r);
const channel = await api(r, 'channels/create', { name: 'Paired channel reactions', allowRenoteToExternal: false }, source.token);
const created = await api(g, 'gridspace/channel-post', { channelId: channel.id, action: 'send', requestId: randomUUID(), text: 'Paired author reaction fixture', asCurrentAccount: true }, grid.token);
const noteId = created.createdNoteId;
const note = await api(r, 'notes/show', { noteId }, source.token);
assert.equal(note.user.host, new URL(g.origin).host);
assert.equal(note.gridspaceReactions, true);
assert.equal(note.localOnly, true);
await api(r, 'notes/extended-reactions/create', { noteId, reaction: '👍' }, source.token);
await api(r, 'notes/extended-reactions/create', { noteId, reaction: '🎉' }, source.token);
const state = (await api(r, 'notes/extended-reactions/show', { noteIds: [noteId] }, source.token))[0];
assert.deepEqual(new Set(state.myReactions), new Set(['👍', '🎉']));
assert.equal(state.shared, false);
const read = () => api(g, 'gridspace/private-notes', { mode: 'show', channelId: channel.id, noteId }, grid.token);
assert.equal((await read()).notes[0].reactions['🎉'], 1);
await api(r, 'notes/extended-reactions/delete', { noteId, reaction: '👍' }, source.token);
const after = (await read()).notes[0];
assert.equal(after.reactions['🎉'], 1);
assert.equal(after.reactions['👍'] ?? 0, 0);
assert.equal((await fetch(`${r.origin}/notes/${noteId}`, { headers: { accept: 'application/activity+json' } })).status, 404);
console.log('PASS: R adds two reactions to a G-authored channel note, removes one, G sees the remaining reaction, no ActivityPub note exposure.');
