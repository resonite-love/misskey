/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserNotePining } from '@/models/UserNotePining.js';
import { MiClip } from '@/models/Clip.js';
import { ApiError } from '@/server/api/error.js';
import { RoleService } from '@/core/RoleService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GRIDSPACE_ACTION_SCOPE, GRIDSPACE_PRIVATE_SCOPE } from './link-crypto.js';
import type { NoteMenuOptions, NoteMenuPeerRequest } from './note-menu-protocol.js';

@Injectable()
export class GridspaceNoteMenuService {
 constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
  private links: GridspaceLinkService, private reader: GridspacePrivateService, private modules: ModuleRef) {}
 private async native<T>(path: string, data: object, user: MiLocalUser): Promise<T> {
  return this.modules.get<{ exec: (data: object, user: MiLocalUser, token: null) => Promise<T> }>('ep:' + path, { strict: false }).exec(data, user, null);
 }
 public async peer(input: NoteMenuPeerRequest, rateLimit: (userId: string) => Promise<void>) {
  const link = await this.links.authorizePrivate(input);
  if (input.channelId && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
  const user = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, host: IsNull(), isSuspended: false, isDeleted: false, movedToUri: IsNull() }) as MiLocalUser | null;
  const note = user && await this.reader.readableSourceNote(user.id, input.noteId, undefined, input.channelId);
  if (!user || !note || (note.channelId ?? undefined) !== input.channelId) throw new GridspaceLinkError('ACTION_REJECTED');
  const actorUri = new URL('/users/' + user.id, this.config.url).href;
  const canWrite = await this.links.hasActionScope(input);
  const state = await this.native<{ isFavorited: boolean; isMutedThread: boolean }>('notes/state', { noteId: note.id }, user);
  const result = { ...state, actorUri, canWrite, isOwn: note.userId === user.id,
   isPinned: await this.db.getRepository(MiUserNotePining).existsBy({ userId: user.id, noteId: note.id }), deleted: false,
   clips: [] as { id: string; name: string }[], translation: undefined as { text: string; sourceLang: string } | undefined,
   clipError: undefined as 'already-added' | 'too-many' | undefined };
  const finish = async () => {
   await this.links.authorizePrivate(input);
   if (input.action !== 'state' && input.action !== 'translate' && !await this.links.hasActionScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
   if (!result.deleted && !await this.reader.readableSourceNote(user.id, note.id, undefined, input.channelId)) throw new GridspaceLinkError('ACTION_REJECTED');
   return result;
  };
  if (input.action === 'state') return finish();
  if (input.action === 'clips') {
   if (!canWrite) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
   result.clips = (await this.native<{ id: string; name: string }[]>('clips/list', { limit: 100 }, user)).map(({ id, name }) => ({ id, name }));
   return finish();
  }
  const translating = input.action === 'translate';
  if ((!translating && !canWrite) || input.expectedActorUri !== actorUri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
  if (['pin', 'unpin', 'delete'].includes(input.action) && !result.isOwn) throw new GridspaceLinkError('ACTION_REJECTED');
  if (translating && !(await this.modules.get(RoleService, { strict: false }).getUserPolicies(user.id)).canUseTranslator) throw new GridspaceLinkError('ACTION_REJECTED');
  await rateLimit(user.id);
  await this.db.transaction(async manager => {
   await this.links.lockReplyAuthorization(input, manager, translating ? GRIDSPACE_PRIVATE_SCOPE : GRIDSPACE_ACTION_SCOPE);
   if (!await this.reader.readableSourceNote(user.id, note.id, manager.queryRunner, input.channelId)) throw new GridspaceLinkError('ACTION_REJECTED');
   const basic = { noteId: note.id };
   try {
    switch (input.action) {
     case 'favorite': await this.native('notes/favorites/create', basic, user); result.isFavorited = true; break;
     case 'unfavorite': await this.native('notes/favorites/delete', basic, user); result.isFavorited = false; break;
     case 'mute-thread': await this.native('notes/thread-muting/create', basic, user); result.isMutedThread = true; break;
     case 'unmute-thread': await this.native('notes/thread-muting/delete', basic, user); result.isMutedThread = false; break;
     case 'pin': await this.native('i/pin', basic, user); result.isPinned = true; break;
     case 'unpin': await this.native('i/unpin', basic, user); result.isPinned = false; break;
     case 'delete': await this.native('notes/delete', basic, user); result.deleted = true; break;
     case 'translate':
      if (!input.targetLang) throw new GridspaceLinkError('ACTION_REJECTED');
      result.translation = await this.native('notes/translate', { ...basic, targetLang: input.targetLang }, user); break;
     case 'report':
      if (!input.comment || result.isOwn) throw new GridspaceLinkError('ACTION_REJECTED');
      await this.native('users/report-abuse', { userId: note.userId, comment: input.comment + '\nNote: ' + (note.uri ?? new URL('/notes/' + note.id, this.config.url).href) }, user); break;
     case 'clip-create': {
      if (!input.name) throw new GridspaceLinkError('ACTION_REJECTED');
      const clip = await this.native<{ id: string }>('clips/create', { name: input.name, description: input.description ?? null, isPublic: input.isPublic ?? false }, user);
      try { await this.native('clips/add-note', { ...basic, clipId: clip.id }, user); } catch (error) { await this.native('clips/delete', { clipId: clip.id }, user); throw error; }
      break;
     }
     case 'clip-add': case 'clip-remove':
      if (!input.clipId || !await manager.getRepository(MiClip).existsBy({ id: input.clipId, userId: user.id })) throw new GridspaceLinkError('ACTION_REJECTED');
      await this.native(input.action === 'clip-add' ? 'clips/add-note' : 'clips/remove-note', { ...basic, clipId: input.clipId }, user); break;
     default: throw new GridspaceLinkError('ACTION_REJECTED');
    }
   } catch (error) {
    if (input.action === 'clip-add' && error instanceof ApiError && error.code === 'ALREADY_CLIPPED') result.clipError = 'already-added';
    else if (input.action === 'clip-add' && error instanceof ApiError && error.code === 'TOO_MANY_CLIP_NOTES') result.clipError = 'too-many';
    else if (error instanceof ApiError && ['ALREADY_FAVORITED', 'NOT_FAVORITED', 'ALREADY_MUTING', 'NOT_MUTING', 'ALREADY_PINNED'].includes(error.code)) {
     if (input.action === 'favorite' || input.action === 'unfavorite') result.isFavorited = input.action === 'favorite';
     if (input.action === 'mute-thread' || input.action === 'unmute-thread') result.isMutedThread = input.action === 'mute-thread';
     if (input.action === 'pin' || input.action === 'unpin') result.isPinned = input.action === 'pin';
    } else throw error;
   }
  });
  return finish();
 }
 public async menu(viewer: MiLocalUser, input: NoteMenuOptions) {
  const link = await this.links.privateLink(viewer.id);
  if (!(await this.reader.notes(viewer, { mode: 'show', noteId: input.noteId, channelId: input.channelId }, 1)).notes.length) throw new GridspaceLinkError('ACTION_REJECTED');
  const { action, noteId, channelId, expectedActorUri, clipId, name, description, isPublic, targetLang, comment } = input;
  const result = await this.links.json<Awaited<ReturnType<GridspaceNoteMenuService['peer']>>>('/gridspace/v1/private/note-menu', {
   action, noteId, channelId, expectedActorUri, clipId, name, description, isPublic, targetLang, comment, ...this.links.privateCredential(link),
  });
  await this.links.checkPrivateUnchanged(link);
  if (result.actorUri !== new URL('/users/' + link.peerUserId, link.peerOrigin).href) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
  return result;
 }
}
