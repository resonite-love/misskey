/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import { privateNoteSchema, PRIVATE_FILE_LIMIT } from './private-protocol.js';

export type ActionOptions = { action: 'prepare' | 'react' | 'vote' | 'add-reaction' | 'remove-reaction' | 'reaction-list'; noteId: string; channelId?: string; expectedActorUri?: string; reaction?: string | null; choice?: number; untilId?: string; limit?: number };
export type ActionPeerRequest = GridspacePeerLinkRequest & ActionOptions;
export type UploadOptions = { noteId?: string; channelId?: string; expectedActorUri?: string; name: string; comment?: string | null; isSensitive?: boolean };
export type UploadPeerRequest = GridspacePeerLinkRequest & UploadOptions & { data: string; sourceFileUrl?: string };
const text = { type: 'string', optional: false, nullable: false } as const;
export const actionOptionsSchema = {
	action: { type: 'string', enum: ['prepare', 'react', 'vote', 'add-reaction', 'remove-reaction', 'reaction-list'], default: 'prepare' },
	noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	expectedActorUri: { type: 'string', maxLength: 512 },
	reaction: { type: 'string', nullable: true, minLength: 1, maxLength: 260 },
	choice: { type: 'integer', minimum: 0, maximum: 100 },
	untilId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,2048}$' },
	limit: { type: 'integer', minimum: 1, maximum: 100 },
} as const;
export const actionResultSchema = { type: 'object', optional: false, nullable: false, properties: {
	canInteract: { type: 'boolean', optional: false, nullable: false },
	account: privateNoteSchema.properties.author,
	note: privateNoteSchema,
	reactors: { type: 'array', optional: true, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
		id: text, reaction: text, account: privateNoteSchema.properties.author,
	} } },
} } as const;
export const uploadOptionsSchema = {
	noteId: actionOptionsSchema.noteId,
	channelId: actionOptionsSchema.channelId,
	expectedActorUri: actionOptionsSchema.expectedActorUri,
	name: { type: 'string', minLength: 1, maxLength: 200 },
	comment: { type: 'string', nullable: true, maxLength: 500 },
	isSensitive: { type: 'boolean', default: false },
} as const;
export const uploadWireSchema = { ...uploadOptionsSchema, sourceFileUrl: { type: 'string', maxLength: 2048, pattern: '^https://' }, data: { type: 'string', minLength: 4, maxLength: Math.ceil(PRIVATE_FILE_LIMIT / 3) * 4, pattern: '^[A-Za-z0-9+/]+={0,2}$' } } as const;
export const uploadResultSchema = { type: 'object', optional: false, nullable: false, properties: { id: text, name: text } } as const;
