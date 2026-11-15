/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GetterService } from '@/server/api/GetterService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import Endpoint, { parseNoteLink } from '@/server/api/endpoints/gridspace/note-link.js';
const config = { url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example', channelRole: 'client' } } as Config;
const link = 'https://g.example/gridspace/private?noteId=abc&channelId=channel';

describe('linked note URLs', () => {
	test('maps the viewer URL to the opposite server rather than assuming the ID is local', () => {
		expect(parseNoteLink(link, config)).toEqual({ noteId: 'abc', channelId: 'channel', local: false });
		expect(parseNoteLink(link, { ...config, url: 'https://r.example', gridspace: { ...config.gridspace!, channelRole: 'source', peerUrl: 'https://g.example' } })).toEqual({ noteId: 'abc', channelId: 'channel', local: true });
	});
	test.each(['https://evil.example/gridspace/private?noteId=abc', 'https://g.example/gridspace/private?noteId=a&noteId=b', 'https://g.example/gridspace/private?noteId=abc&channelId=../channel', 'https://g.example/gridspace/private?noteId=abc&token=secret', 'https://user@g.example/gridspace/private?noteId=abc', 'http://g.example/gridspace/private?noteId=abc'])('rejects noncanonical or unrelated URLs: %s', value => {
		expect(() => parseNoteLink(value, config)).toThrow();
	});
	test('uses the authenticated reader and rejects a changed channel or denied note', async () => {
		const reader = mockDeep<GridspacePrivateService>();
		const endpoint = new Endpoint(config, reader, mockDeep<GetterService>(), mockDeep<NoteEntityService>());
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
		const endpoint = new Endpoint({ ...config, url: 'https://r.example', gridspace: { ...config.gridspace!, peerUrl: 'https://g.example', channelRole: 'source' } }, mockDeep<GridspacePrivateService>(), getter, packer);
		getter.getNote.mockResolvedValue({ id: 'abc', channelId: 'channel' } as never);
		packer.pack.mockResolvedValue({ id: 'abc', isHidden: false } as never);
		expect((await endpoint.exec({ url: link }, { id: 'viewer' } as MiLocalUser, null)).localNote.id).toBe('abc');
		getter.getNote.mockResolvedValueOnce({ id: 'abc', channelId: 'wrong' } as never);
		await expect(endpoint.exec({ url: link }, { id: 'viewer' } as MiLocalUser, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
		packer.pack.mockResolvedValue({ id: 'abc', isHidden: true } as never);
		await expect(endpoint.exec({ url: link }, { id: 'viewer' } as MiLocalUser, null)).rejects.toMatchObject({ code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE' });
	});
});
