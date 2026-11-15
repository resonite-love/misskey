/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspacePublicNoteService } from './GridspacePublicNoteService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GetterService } from '@/server/api/GetterService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import Endpoint, { meta, parseNoteLink } from '@/server/api/endpoints/gridspace/note-link.js';
const config = { url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example', channelRole: 'client' } } as Config;
const link = 'https://g.example/gridspace/private?noteId=abc&channelId=channel';

describe('linked note URLs', () => {
	test('anonymous readers only use the public resolver, never an account grant', async () => {
		expect(meta.requireCredential).toBe(false);
		expect('secure' in meta && meta.secure).toBeFalsy();
		const reader = mockDeep<GridspacePrivateService>(), publicNotes = mockDeep<GridspacePublicNoteService>();
		const endpoint = new Endpoint(config, reader, mockDeep<GetterService>(), mockDeep<NoteEntityService>(), publicNotes);
		publicNotes.resolve.mockResolvedValue({ note: { id: 'abc' }, publicUrl: 'https://r.example/notes/abc' } as never);
		expect(await endpoint.exec({ url: link }, null, null)).toMatchObject({ publicUrl: 'https://r.example/notes/abc', localNote: { id: 'abc' }, note: null });
		expect(publicNotes.resolve).toHaveBeenCalledWith({ noteId: 'abc', channelId: 'channel' }, false);
		expect(reader.notes).not.toHaveBeenCalled();
		publicNotes.resolve.mockRejectedValue(new Error('private'));
		await expect(endpoint.exec({ url: link }, null, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
	});
	test('keeps third-party tokens and suspended users out of the delegated reader', async () => {
		const reader = mockDeep<GridspacePrivateService>();
		const endpoint = new Endpoint(config, reader, mockDeep<GetterService>(), mockDeep<NoteEntityService>(), mockDeep<GridspacePublicNoteService>());
		await expect(endpoint.exec({ url: link }, { id: 'viewer' }, { id: 'app' })).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
		await expect(endpoint.exec({ url: link }, { id: 'viewer', isSuspended: true }, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
		expect(reader.notes).not.toHaveBeenCalled();
	});
	test('maps the viewer URL to the opposite server rather than assuming the ID is local', () => {
		expect(parseNoteLink(link, config)).toEqual({ noteId: 'abc', channelId: 'channel', local: false });
		expect(parseNoteLink(link, { ...config, url: 'https://r.example', gridspace: { ...config.gridspace!, channelRole: 'source', peerUrl: 'https://g.example' } })).toEqual({ noteId: 'abc', channelId: 'channel', local: true });
	});
	test.each(['https://evil.example/gridspace/private?noteId=abc', 'https://g.example/gridspace/private?noteId=a&noteId=b', 'https://g.example/gridspace/private?noteId=abc&channelId=../channel', 'https://g.example/gridspace/private?noteId=abc&token=secret', 'https://user@g.example/gridspace/private?noteId=abc', 'http://g.example/gridspace/private?noteId=abc'])('rejects noncanonical or unrelated URLs: %s', value => {
		expect(() => parseNoteLink(value, config)).toThrow();
	});
	test('uses the authenticated reader and rejects a changed channel or denied note', async () => {
		const reader = mockDeep<GridspacePrivateService>();
		const endpoint = new Endpoint(config, reader, mockDeep<GetterService>(), mockDeep<NoteEntityService>(), mockDeep<GridspacePublicNoteService>());
		reader.notes.mockResolvedValue({ notes: [{ id: 'abc', channelId: 'channel' }], cursor: null } as never);
		const me = { id: 'viewer' } as MiLocalUser;
		expect((await endpoint.exec({ url: link }, me, null)).note.id).toBe('abc');
		expect(reader.notes).toHaveBeenCalledWith(me, { mode: 'show', noteId: 'abc', channelId: 'channel' }, 1);
		reader.notes.mockResolvedValue({ notes: [{ id: 'abc', channelId: 'another' }] } as never);
		await expect(endpoint.exec({ url: link }, me, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
		reader.notes.mockResolvedValue({ notes: [] } as never);
		await expect(endpoint.exec({ url: link }, me, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
	});
	test('the source uses the normal visibility check and refuses a mismatched channel', async () => {
		const getter = mockDeep<GetterService>(), packer = mockDeep<NoteEntityService>();
		const endpoint = new Endpoint({ ...config, url: 'https://r.example', gridspace: { ...config.gridspace!, peerUrl: 'https://g.example', channelRole: 'source' } }, mockDeep<GridspacePrivateService>(), getter, packer, mockDeep<GridspacePublicNoteService>());
		getter.getNote.mockResolvedValue({ id: 'abc', channelId: 'channel' } as never);
		packer.pack.mockResolvedValue({ id: 'abc', isHidden: false } as never);
		expect((await endpoint.exec({ url: link }, { id: 'viewer' } as MiLocalUser, null)).localNote.id).toBe('abc');
		getter.getNote.mockResolvedValueOnce({ id: 'abc', channelId: 'wrong' } as never);
		await expect(endpoint.exec({ url: link }, { id: 'viewer' } as MiLocalUser, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
		packer.pack.mockResolvedValue({ id: 'abc', isHidden: true } as never);
		await expect(endpoint.exec({ url: link }, { id: 'viewer' } as MiLocalUser, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
	});
});
