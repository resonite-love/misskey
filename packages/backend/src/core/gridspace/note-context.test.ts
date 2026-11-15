/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { SelectQueryBuilder } from 'typeorm';
import type { MiNote } from '@/models/Note.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import PrivateNotesEndpoint from '@/server/api/endpoints/gridspace/private-notes.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import type { PrivatePeerRequest } from './private-protocol.js';

function fixture() {
	const query = mockDeep<SelectQueryBuilder<MiNote>>();
	for (const method of ['andWhere', 'orderBy', 'take', 'setParameter'] as const) query[method].mockReturnValue(query);
	const anchor = { id: 'anchor', userId: 'author', channelId: 'channel' } as MiNote;
	const readable = vi.fn(async () => anchor as MiNote | null);
	const noteQuery = vi.fn(() => query);
	const read = vi.fn(async () => []);
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), { readableSourceNote: readable, query: noteQuery, search: { read } }) as GridspacePrivateService;
	const input: PrivatePeerRequest = { mode: 'context', contextScope: 'channel', noteId: 'anchor', channelId: 'channel', limit: 10 };
	return { service, query, anchor, readable, noteQuery, read, input };
}

test.each([['oldest', 'ASC', '>'], ['newest', 'DESC', '<']] as const)('loads the nearest %s context using exclusive source IDs', async (order, direction, comparison) => {
	const f = fixture();
	await f.service['sourceNotes']('viewer', { ...f.input, order, before: 'pageBoundary' });
	expect(f.readable).toHaveBeenCalledWith('viewer', 'anchor', undefined, 'channel');
	expect(f.noteQuery).toHaveBeenCalledWith('viewer', expect.objectContaining({ channelId: 'channel' }));
	expect(f.query.andWhere).toHaveBeenCalledWith(`note.id ${comparison} :contextAnchor`, { contextAnchor: 'anchor' });
	expect(f.query.andWhere).toHaveBeenCalledWith(`note.id ${comparison} :before`, { before: 'pageBoundary' });
	expect(f.query.orderBy).toHaveBeenCalledWith('note.id', direction);
	expect(f.query.take).toHaveBeenCalledWith(11);
});

test('author navigation derives the original author and excludes channel notes like users/notes', async () => {
	const f = fixture();
	await f.service['sourceNotes']('viewer', { ...f.input, contextScope: 'user', channelActorId: 'guest' });
	expect(f.noteQuery).toHaveBeenCalledWith('viewer', expect.objectContaining({ channelId: undefined }));
	expect(f.query.andWhere).toHaveBeenCalledWith('note.userId = :contextAuthor AND note.channelId IS NULL', { contextAuthor: 'author' });
	expect(f.query.andWhere).toHaveBeenCalledWith("note.visibility IN ('public', 'home')");
});

test('context validation rechecks the anchor, author and channel before returning loaded IDs', async () => {
	const f = fixture();
	await f.service['sourceNotes']('viewer', { ...f.input, mode: 'validate', contextMode: 'context', ids: ['one', 'two'] });
	expect(f.readable).toHaveBeenCalledOnce();
	expect(f.query.andWhere).toHaveBeenCalledWith('note.id IN (:...ids)', { ids: ['one', 'two'] });
	f.readable.mockResolvedValue(null);
	await expect(f.service['sourceNotes']('viewer', f.input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});

test('rejects an unrelated channel, missing anchor and caller-selected authors', async () => {
	for (const patch of [{ channelId: 'wrong' }, { noteId: undefined }, { contextScope: undefined }, { targetUris: ['https://r.example/users/other'] }]) {
		const f = fixture();
		await expect(f.service['sourceNotes']('viewer', { ...f.input, ...patch })).rejects.toBeTruthy();
		expect(f.read).not.toHaveBeenCalled();
	}
});

test('a non-validation contextMode cannot bypass the required context anchor', async () => {
	const f = fixture();
	await expect(f.service.peerNotes({ mode: 'context', contextMode: 'home', channelId: 'channel' } as PrivatePeerRequest)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	expect(f.read).not.toHaveBeenCalled();
});

test('the REST validator accepts context fields and validates their values', async () => {
	const reader = mockDeep<GridspacePrivateService>();
	const endpoint = new PrivateNotesEndpoint(reader, mockDeep<GridspaceLinkService>());
	const user = { id: 'viewer' } as never;
	await endpoint.exec({ mode: 'context', contextScope: 'channel', noteId: 'anchor', channelId: 'channel', order: 'oldest' }, user, null);
	expect(reader.notes).toHaveBeenCalledWith(user, expect.objectContaining({ mode: 'context', contextScope: 'channel', noteId: 'anchor', order: 'oldest' }), 10, undefined);
	for (const value of [{ contextScope: 'other' }, { noteId: '../secret' }]) await expect(endpoint.exec({ mode: 'context', ...value }, user, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
});

test('channel guests need a scoped channel anchor and reverse links cannot browse context', async () => {
	const f = fixture();
	Object.assign(f.service, { channelAuth: { assertSource: vi.fn(), source: vi.fn(async () => ({ id: 'guest' })) }, links: { authorizePrivate: vi.fn(async () => ({ initiator: true, localUserId: 'viewer' })) } });
	expect(await f.service['authorizeRead']({ ...f.input, channelActorId: 'guest' })).toMatchObject({ localUserId: 'guest' });
	await expect(f.service['authorizeRead']({ ...f.input, channelId: undefined, channelActorId: 'guest' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	await expect(f.service.peerNotes({ ...f.input, channelId: undefined })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
});
