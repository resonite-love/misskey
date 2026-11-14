/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';
export const noteMenuActions = ['state', 'clips', 'favorite', 'unfavorite', 'mute-thread', 'unmute-thread', 'pin', 'unpin', 'delete', 'translate', 'report', 'clip-add', 'clip-remove', 'clip-create'] as const;
export type NoteMenuOptions = { action: typeof noteMenuActions[number]; noteId: string; channelId?: string; expectedActorUri?: string; clipId?: string; name?: string; description?: string | null; isPublic?: boolean; targetLang?: string; comment?: string };
export type NoteMenuPeerRequest = GridspacePeerLinkRequest & NoteMenuOptions;
const text = { type: 'string', optional: false, nullable: false } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
export const noteMenuProperties = {
 action: { type: 'string', enum: noteMenuActions, default: 'state' }, noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
 expectedActorUri: { type: 'string', maxLength: 512 }, clipId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
 name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', nullable: true, maxLength: 2048 }, isPublic: { type: 'boolean' },
 targetLang: { type: 'string', minLength: 2, maxLength: 35, pattern: '^[a-zA-Z-]+$' }, comment: { type: 'string', minLength: 1, maxLength: 1800 },
} as const;
export const noteMenuResultSchema = { type: 'object', optional: false, nullable: false, properties: {
 actorUri: text, canWrite: flag, isOwn: flag, isPinned: flag, isFavorited: flag, isMutedThread: flag, deleted: flag,
 clips: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: { id: text, name: text } } },
 translation: { type: 'object', optional: true, nullable: false, properties: { text, sourceLang: text } },
 clipError: { type: 'string', enum: ['already-added', 'too-many'], optional: true, nullable: false },
} } as const;
