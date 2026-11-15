/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiNote } from '@/models/Note.js';
import type { Packed } from '@/misc/json-schema.js';
import type { NotesRepository } from '@/models/_.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePublicNoteService } from './GridspacePublicNoteService.js';

const config = { url: 'https://r.example', gridspace: { enabled: true, peerUrl: 'https://g.example', channelRole: 'source' } } as Config;
const meta = { ugcVisibilityForVisitor: 'all' } as MiMeta;
const notes = mockDeep<NotesRepository>(), packer = mockDeep<NoteEntityService>(), links = mockDeep<GridspaceLinkService>();
const service = new GridspacePublicNoteService(config, meta, notes, packer, links);
let source: MiNote;
let packed: Packed<'Note'>;

beforeEach(() => {
	source = { id: 'note', visibility: 'public', channelId: 'channel', userHost: null, user: {} } as MiNote;
	packed = { ...source, user: { host: null }, reply: null, renote: null } as Packed<'Note'>;
	meta.ugcVisibilityForVisitor = 'all';
	notes.findOne.mockReset().mockImplementation(async () => source);
	packer.pack.mockReset().mockImplementation(async () => packed);
	links.json.mockReset();
});

test('reads local-only public channel posts as a visitor, without delegated credentials', async () => {
	source.localOnly = true;
	expect(await service.resolve({ noteId: 'note', channelId: 'channel' }, true)).toMatchObject({ publicUrl: 'https://r.example/notes/note' });
	expect(packer.pack).toHaveBeenCalledWith(source, null, { detail: true });
	expect(links.json).not.toHaveBeenCalled();
});

test.each(['followers', 'specified'] as const)('does not expose %s posts', async visibility => {
	source.visibility = visibility;
	await expect(service.local({ noteId: 'note', channelId: 'channel' })).rejects.toThrow();
	expect(packer.pack).not.toHaveBeenCalled();
});

test('honors author, server, hidden-history and channel restrictions', async () => {
	source.user!.requireSigninToViewContents = true;
	await expect(service.local({ noteId: 'note', channelId: 'channel' })).rejects.toThrow();
	source.user!.requireSigninToViewContents = false; meta.ugcVisibilityForVisitor = 'none';
	await expect(service.local({ noteId: 'note', channelId: 'channel' })).rejects.toThrow();
	meta.ugcVisibilityForVisitor = 'local'; source.userHost = 'remote.example';
	await expect(service.local({ noteId: 'note', channelId: 'channel' })).rejects.toThrow();
	source.userHost = null; packed.isHidden = true;
	await expect(service.local({ noteId: 'note', channelId: 'channel' })).rejects.toThrow();
	packed.isHidden = false;
	await expect(service.local({ noteId: 'note', channelId: 'other' })).rejects.toThrow();
});

test('removes restricted quoted content without hiding its public parent', async () => {
	packed.renote = { ...packed, id: 'private', visibility: 'followers', text: 'SECRET' };
	expect((await service.local({ noteId: 'note', channelId: 'channel' })).renote).toBeNull();
});

test('peer resolution sends only a bounded note reference and verifies the result', async () => {
	links.json.mockResolvedValue(packed);
	expect(await service.resolve({ noteId: 'note', channelId: 'channel' }, false)).toMatchObject({ publicUrl: 'https://g.example/notes/note' });
	expect(links.json).toHaveBeenCalledWith('/gridspace/v1/notes/public', { noteId: 'note', channelId: 'channel' });
	links.json.mockResolvedValue({ ...packed, channelId: 'wrong' });
	await expect(service.resolve({ noteId: 'note', channelId: 'channel' }, false)).rejects.toThrow();
});

test.each(['none', 'local'] as const)('returns only the verified source link under destination visitor policy %s', async policy => {
	meta.ugcVisibilityForVisitor = policy;
	links.json.mockResolvedValue(packed);
	expect(await service.resolve({ noteId: 'note', channelId: 'channel' }, false)).toEqual({ note: null, publicUrl: 'https://g.example/notes/note' });
});
