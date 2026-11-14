/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Ref } from 'vue';
import type { entities } from 'misskey-js';
import type { MenuItem } from '@/types/menu.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { getNoteMenu } from '@/utility/get-note-menu.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { url } from '@@/js/config.js';
import { globalEvents } from '@/events.js';
import { miLocalStorage } from '@/local-storage.js';
import { isSupportShare } from '@/utility/navigator.js';
import { clipsCache } from '@/cache.js';
import { $i } from '@/i.js';
import { instance } from '@/instance.js';
import { getUserMenu } from '@/utility/get-user-menu.js';

type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];
export type LinkedClipContext = { id: string; canManage: boolean };

export async function getGridspaceNoteMenu(note: PrivateNote, detailPath: string, translation: Ref<entities.NotesTranslateResponse | null>, translating: Ref<boolean>, currentClip?: LinkedClipContext | null, isCurrent: () => boolean = () => true) {
 let state: entities.GridspaceNoteMenuResponse | null = null;
 const cleanups: (() => void)[] = [];
 let menuClosed = false;
 const addCleanup = (dispose: () => void) => { if (menuClosed) dispose(); else cleanups.push(dispose); };
 const cleanup = () => { menuClosed = true; cleanups.splice(0).forEach(dispose => dispose()); };
 const available = () => isCurrent() && !window.document.hidden;
 const request = async (action: entities.GridspaceNoteMenuRequest['action'], extra: Partial<entities.GridspaceNoteMenuRequest> = {}) => {
  if (!available()) return null;
  state ??= await misskeyApi('gridspace/note-menu', { noteId: note.id, channelId: note.channelId ?? undefined, action: 'state' });
  if (!available()) return null;
  const result = await os.apiWithDialog('gridspace/note-menu', { ...extra, action, noteId: note.id, channelId: note.channelId ?? undefined, expectedActorUri: state!.actorUri });
  if (!available()) return null;
  if (result.deleted) globalEvents.emit('gridspaceNoteDeleted', note.id);
  return result;
 };
 const removeFromClip = async (clipId: string) => {
  if (!await request('clip-remove', { clipId })) return;
  clipsCache.delete();
  globalEvents.emit('gridspaceClipNoteRemoved', clipId, note.id);
 };
 const unclip: MenuItem = { text: i18n.ts.unclip, icon: 'ti ti-backspace', danger: true, action: () => removeFromClip(currentClip!.id) };
 // Public notes can use independently authorized normal note APIs. Keep the
 // delegated clip context separate: source IDs never enter a local note API.
 if (!note.channelId && ['public', 'home'].includes(note.visibility)) {
  try {
   const local = await misskeyApi('gridspace/renote-target', { noteId: note.id });
   const result = getNoteMenu({ note: local, translation, translating });
   addCleanup(result.cleanup);
   if (currentClip?.canManage) result.menu.unshift(unclip, { type: 'divider' });
   return { menu: result.menu, cleanup };
  } catch { /* Use the delegated menu if no normal representation is readable. */ }
 }
 const menu: MenuItem[] = [];
 try { state = await misskeyApi('gridspace/note-menu', { action: 'state', noteId: note.id, channelId: note.channelId ?? undefined }); } catch { /* Read-only actions still work during a peer outage. */ }
 if (currentClip?.canManage && state?.canWrite) menu.push(unclip, { type: 'divider' });
 menu.push({ text: i18n.ts.details, icon: 'ti ti-info-circle', action: () => os.pageWindow(detailPath) },
  { text: i18n.ts.copyContent, icon: 'ti ti-copy', action: () => copyToClipboard(note.text ?? '') },
  { text: i18n.ts.copyLink, icon: 'ti ti-link', action: () => copyToClipboard(`${url}${detailPath}`) },
  { text: i18n.ts.copyRemoteLink, icon: 'ti ti-link', action: () => copyToClipboard(note.uri) },
  { text: i18n.ts.showOnRemote, icon: 'ti ti-external-link', action: () => { window.open(note.uri, '_blank', 'noopener'); } });
 if (isSupportShare()) menu.push({ text: i18n.ts.share, icon: 'ti ti-share', action: () => { void navigator.share({ text: note.text ?? '', url: `${url}${detailPath}` }); } });
 if (state && $i?.policies.canUseTranslator && instance.translatorAvailable) menu.push({ text: i18n.ts.translate, icon: 'ti ti-language-hiragana', action: async () => {
  translating.value = true;
  try { const result = await request('translate', { targetLang: miLocalStorage.getItem('lang') ?? navigator.language }); if (available() && result?.translation) translation.value = result.translation; } finally { translating.value = false; }
 } });
 if (state?.canWrite) {
  menu.push({ type: 'divider' }, { text: state.isFavorited ? i18n.ts.unfavorite : i18n.ts.favorite, icon: state.isFavorited ? 'ti ti-star-off' : 'ti ti-star', action: () => request(state!.isFavorited ? 'unfavorite' : 'favorite') },
   { type: 'parent', text: i18n.ts.clip, icon: 'ti ti-paperclip', children: async () => {
    const result = await request('clips');
    if (!result) return [];
    const children: MenuItem[] = result.clips.map(clip => ({ text: clip.name, action: async () => {
     const added = await request('clip-add', { clipId: clip.id });
     if (added?.clipError === 'already-added') {
      const confirm = await os.confirm({ type: 'warning', text: i18n.tsx.confirmToUnclipAlreadyClippedNote({ name: clip.name }) });
      if (!confirm.canceled && available()) await removeFromClip(clip.id);
     } else if (added?.clipError === 'too-many') await os.alert({ type: 'error', text: i18n.ts.clipNoteLimitExceeded });
     clipsCache.delete();
    } }));
    children.push({ type: 'divider' }, { text: i18n.ts.createNew, icon: 'ti ti-plus', action: async () => {
     const form = await os.form(i18n.ts.createNewClip, { name: { type: 'string', label: i18n.ts.name }, description: { type: 'string', required: false, multiline: true, label: i18n.ts.description }, isPublic: { type: 'boolean', default: false, label: i18n.ts.public } });
     if (!form.canceled && available()) { await request('clip-create', form.result); clipsCache.delete(); }
    } });
    return children;
   } },
   { text: state.isMutedThread ? i18n.ts.unmuteThread : i18n.ts.muteThread, icon: 'ti ti-message-off', action: () => request(state!.isMutedThread ? 'unmute-thread' : 'mute-thread') });
  if (state.isOwn) menu.push({ text: state.isPinned ? i18n.ts.unpin : i18n.ts.pin, icon: state.isPinned ? 'ti ti-pinned-off' : 'ti ti-pin', action: () => request(state!.isPinned ? 'unpin' : 'pin') });
  menu.push({ type: 'parent', text: i18n.ts.user, icon: 'ti ti-user', children: async () => {
   const user = await misskeyApi('users/show', { username: note.author.username, host: note.author.host });
   if (!available()) return [];
   const result = getUserMenu(user); addCleanup(result.cleanup); return result.menu;
  } });
  if (!state.isOwn) menu.push({ type: 'divider' }, { text: i18n.ts.reportAbuse, icon: 'ti ti-exclamation-circle', action: async () => {
   const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkAbuseReportWindow.vue').then(module => module.default), {
    user: { id: note.author.uri, username: note.author.username, name: note.author.name, host: note.author.host, avatarUrl: note.author.avatarUrl, avatarBlurhash: note.author.avatarBlurhash ?? null, avatarDecorations: note.author.avatarDecorations ?? [], isBot: note.author.isBot ?? false, isCat: note.author.isCat ?? false, onlineStatus: 'unknown', emojis: note.author.emojis ?? {} } as entities.UserLite,
    initialComment: 'Note: ' + note.uri + '\n-----\n',
    sendHandler: async (comment: string) => {
     const result = await request('report', { comment });
     if (!result) { await os.alert({ type: 'error', text: i18n.ts._gridspace.unavailableNote }); return false; }
    },
   }, { closed: () => dispose() });
  } });
  if (state.isOwn && !note.channelId) menu.push({ type: 'divider' }, { text: i18n.ts.delete, icon: 'ti ti-trash', danger: true, action: async () => {
   const confirm = await os.confirm({ type: 'warning', text: i18n.ts.noteDeleteConfirm });
   if (!confirm.canceled && available()) await request('delete');
  } });
 }
 // Menu selection closes the popup before a confirmation resolves. Keep the
 // operation alive, but never let a suspended/replaced row act on captured data.
 for (const item of menu) {
  if (item && typeof item === 'object' && 'action' in item) {
   const action = item.action;
   item.action = event => { if (available()) return action(event); };
  }
 }
 return { menu, cleanup };
}
