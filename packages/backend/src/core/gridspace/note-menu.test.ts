/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ApiError } from '@/server/api/error.js';
import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiClip } from '@/models/Clip.js';
import { GridspaceNoteMenuService } from './GridspaceNoteMenuService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { NoteMenuPeerRequest } from './note-menu-protocol.js';

function fixture() {
 const db = mockDeep<DataSource>(), modules = mockDeep<ModuleRef>();
 const links = mockDeep<GridspaceLinkService>(), reader = mockDeep<GridspacePrivateService>();
 const user = { id: 'old', host: null } as MiLocalUser;
 const repo = { findOneBy: vi.fn(async () => user), existsBy: vi.fn(async () => false) };
 db.getRepository.mockReturnValue(repo as never); db.manager.getRepository.mockReturnValue(repo as never);
 db.transaction.mockImplementation((async (work: (manager: unknown) => unknown) => work(db.manager)) as never);
 links.authorizePrivate.mockResolvedValue({ localUserId: 'old' } as MiGridspaceLink);
 links.hasActionScope.mockResolvedValue(true);
 links.privateLink.mockResolvedValue({ peerOrigin: 'https://r.example', peerUserId: 'old' } as MiGridspaceLink);
 links.privateCredential.mockReturnValue({ accessToken: 'secret', linkId: 'link' });
 reader.readableSourceNote.mockResolvedValue({ id: 'note', userId: 'author', channelId: null } as never);
 reader.notes.mockResolvedValue({ notes: [{ id: 'note' }] } as never);
 const native = vi.fn(async (path: string) => path === 'ep:notes/state' ? { isFavorited: false, isMutedThread: false } : path === 'ep:clips/list' ? [{ id: 'clip', name: 'Private', secret: 'not forwarded' }] : undefined);
 const execute = vi.fn((..._args: unknown[]) => undefined);
 modules.get.mockImplementation(((path: string) => ({ exec: async (...args: unknown[]) => { execute(path, ...args); return native(path); } })) as never);
 const service = new GridspaceNoteMenuService(db, { url: 'https://r.example' } as Config, links, reader, modules);
 const input = { action: 'favorite', noteId: 'note', expectedActorUri: 'https://r.example/users/old' } as NoteMenuPeerRequest;
 return { service, db, repo, links, reader, modules, native, execute, user, input };
}

test('uses the source identity and checks authorization under a lock before mutating', async () => {
 const f = fixture();
 const result = await f.service.peer(f.input, async () => {});
 expect(result.isFavorited).toBe(true);
 expect(f.links.lockReplyAuthorization).toHaveBeenCalled();
 expect(f.execute).toHaveBeenCalledWith('ep:notes/favorites/create', { noteId: 'note' }, f.user, null);
});

test.each(['actor', 'scope', 'visibility', 'revocation'] as const)('rejects %s failure before a mutation', async reason => {
 const f = fixture();
 if (reason === 'actor') f.input.expectedActorUri = 'https://r.example/users/other';
 if (reason === 'scope') f.links.hasActionScope.mockResolvedValue(false);
 if (reason === 'visibility') f.reader.readableSourceNote.mockResolvedValue(null);
 if (reason === 'revocation') f.links.lockReplyAuthorization.mockRejectedValue(Error('revoked'));
 await expect(f.service.peer(f.input, async () => {})).rejects.toThrow();
 expect(f.execute.mock.calls.some(([path]) => path === 'ep:notes/favorites/create')).toBe(false);
});

test('lists only the native source-account clips without exposing extra fields', async () => {
 const f = fixture();
 const result = await f.service.peer({ ...f.input, action: 'clips' }, async () => {});
 expect(result.clips).toEqual([{ id: 'clip', name: 'Private' }]);
 expect(f.execute).toHaveBeenCalledWith('ep:clips/list', { limit: 100 }, f.user, null);
});

test('only allows removing from a clip owned by the source account', async () => {
 const f = fixture();
 await expect(f.service.peer({ ...f.input, action: 'clip-remove', clipId: 'foreign' }, async () => {})).rejects.toThrow();
 expect(f.execute.mock.calls.some(([path]) => path === 'ep:clips/remove-note')).toBe(false);
 f.db.manager.getRepository.mockImplementation(((entity: unknown) => entity === MiClip ? { existsBy: vi.fn(async () => true) } : f.repo) as never);
 await f.service.peer({ ...f.input, action: 'clip-remove', clipId: 'owned' }, async () => {});
 expect(f.execute).toHaveBeenCalledWith('ep:clips/remove-note', { noteId: 'note', clipId: 'owned' }, f.user, null);
});

test.each(['delete', 'pin', 'unpin'] as const)('does not grant source moderator privileges for %s', async action => {
 const f = fixture();
 await expect(f.service.peer({ ...f.input, action }, async () => {})).rejects.toThrow();
});

test('does not forward browser credentials or operate on a locally unreadable note', async () => {
 const f = fixture();
 f.links.json.mockResolvedValue({ actorUri: 'https://r.example/users/old' });
 await f.service.menu(f.user, { ...f.input, accessToken: 'attacker', localUserId: 'other' } as never);
 expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/private/note-menu', expect.objectContaining({ accessToken: 'secret' }));
 expect(f.links.json.mock.calls[0][1]).not.toHaveProperty('localUserId', 'other');
 f.links.json.mockClear(); f.reader.notes.mockResolvedValue({ notes: [] } as never);
 await expect(f.service.menu(f.user, f.input)).rejects.toThrow(); expect(f.links.json).not.toHaveBeenCalled();
});

test.each(['state', 'clips'] as const)('rechecks the grant after reading %s', async action => {
 const f = fixture();
 f.links.authorizePrivate.mockResolvedValueOnce({ localUserId: 'old' } as MiGridspaceLink).mockRejectedValue(Error('revoked'));
 await expect(f.service.peer({ ...f.input, action }, async () => {})).rejects.toThrow('revoked');
});

test.each(['state', 'clips'] as const)('rechecks note visibility after reading %s', async action => {
 const f = fixture();
 f.reader.readableSourceNote.mockResolvedValueOnce({ id: 'note', userId: 'author', channelId: null } as never).mockResolvedValue(null);
 await expect(f.service.peer({ ...f.input, action }, async () => {})).rejects.toThrow();
});

test('clip chooser requires action permission', async () => {
 const f = fixture(); f.links.hasActionScope.mockResolvedValue(false);
 await expect(f.service.peer({ ...f.input, action: 'clips' }, async () => {})).rejects.toThrow();
 expect(f.execute.mock.calls.some(([path]) => path === 'ep:clips/list')).toBe(false);
});

test('an already desired favorite returns the requested state', async () => {
 const f = fixture();
 f.native.mockImplementation(async path => {
  if (path === 'ep:notes/state') return { isFavorited: false, isMutedThread: false };
  if (path === 'ep:notes/favorites/create') throw new ApiError({ message: 'Already', code: 'ALREADY_FAVORITED', id: 'duplicate' });
  return undefined;
 });
 expect((await f.service.peer(f.input, async () => {})).isFavorited).toBe(true);
});

test('a new clip is removed if adding its first note fails', async () => {
 const f = fixture();
 f.native.mockImplementation(async path => {
  if (path === 'ep:notes/state') return { isFavorited: false, isMutedThread: false };
  if (path === 'ep:clips/create') return { id: 'created' };
  if (path === 'ep:clips/add-note') throw Error('write failed');
  return undefined;
 });
 await expect(f.service.peer({ ...f.input, action: 'clip-create', name: 'New' }, async () => {})).rejects.toThrow('write failed');
 expect(f.execute).toHaveBeenCalledWith('ep:clips/delete', { clipId: 'created' }, f.user, null);
});
