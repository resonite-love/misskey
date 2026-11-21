/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';
import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import { conversationUriSchema, placementActorIdSchema, type ConversationOptions, type ConversationCredential } from './conversation-protocol.js';

export type NoteClipsRequest = ConversationOptions & { noteId: string; source?: 'local' | 'peer'; channelId?: string };
export type NoteClipsPeerRequest = ConversationCredential & GridspacePeerLinkRequest & { noteId?: string; noteUri?: string; channelId?: string };
export type NoteClipsPeerResult = { origin: string; noteId: string; noteUri: string; clips: Packed<'Clip'>[] };
export const noteClipsPeerSchema = {
	type: 'object', additionalProperties: false,
	oneOf: [{ required: ['noteId'], not: { required: ['noteUri'] } }, { required: ['noteUri'], not: { required: ['noteId'] } }],
	properties: {
		conversationUri: conversationUriSchema, placementActorId: placementActorIdSchema,
		noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		noteUri: { type: 'string', maxLength: 2048 }, channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' },
		generation: { type: 'integer', minimum: 1 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		pairId: { type: 'string', format: 'uuid' }, channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	},
} as const;
