/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';
import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';

export type NoteClipsRequest = { noteId: string; source?: 'local' | 'peer'; channelId?: string };
export type NoteClipsPeerRequest = GridspacePeerLinkRequest & { noteId?: string; noteUri?: string; channelId?: string };
export type NoteClipsPeerResult = { origin: string; noteId: string; noteUri: string; clips: Packed<'Clip'>[] };
export const noteClipsPeerSchema = {
	type: 'object', additionalProperties: false,
	oneOf: [{ required: ['noteId'], not: { required: ['noteUri'] } }, { required: ['noteUri'], not: { required: ['noteId'] } }],
	properties: {
		noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		noteUri: { type: 'string', maxLength: 2048 }, channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' },
		generation: { type: 'integer', minimum: 1 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		pairId: { type: 'string', format: 'uuid' }, channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	},
} as const;
