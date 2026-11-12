/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';

export type PrivateOptions = {
	mode: 'home' | 'search' | 'profile' | 'show' | 'validate';
	contextMode?: 'home' | 'search' | 'profile' | 'show';
	query?: string; userId?: string; noteId?: string; ids?: string[];
	rangeStartAt?: number; rangeEndAt?: number;
	withReplies?: boolean; withRenotes?: boolean; withFiles?: boolean; withChannelNotes?: boolean;
};
export type PrivatePeerRequest = GridspacePeerLinkRequest & Omit<PrivateOptions, 'userId'> & {
	targetUris?: string[]; before?: string; head?: string; limit?: number; fileId?: string;
};
export type PrivateActor = { name: string | null; username: string; host: string; uri: string };
export type PrivateNote = {
	id: string; uri: string; createdAt: string; origin: string; text: string | null; cw: string | null;
	visibility: string; localOnly: boolean; author: PrivateActor & { avatarUrl: string };
	replyId: string | null; renoteId: string | null;
	files: { id: string; name: string; type: string; size: number; comment: string | null; isSensitive: boolean }[];
	poll: { choices: { text: string; votes: number }[]; expiresAt: string | null; multiple: boolean } | null;
};
export type PrivateWireNote = PrivateNote & { filterActors: PrivateActor[] };
export type PrivatePage = { notes: PrivateWireNote[]; next: string | null; head: string | null; scannedThrough: string | null; observedAt: string };
export const PRIVATE_FILE_LIMIT = 16 * 1024 * 1024;

const text = { type: 'string', optional: false, nullable: false } as const;
const nullableText = { ...text, nullable: true } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
const integer = { type: 'integer', optional: false, nullable: false } as const;

// Deliberately not the shared Note schema: these IDs belong to the peer and
// must never be inserted into normal note caches or used for local mutations.
export const privateNoteSchema = {
	type: 'object', optional: false, nullable: false, properties: {
		id: text, uri: text, createdAt: text, origin: text, text: nullableText, cw: nullableText, visibility: text, localOnly: flag,
		author: { type: 'object', optional: false, nullable: false, properties: { name: nullableText, username: text, host: text, uri: text, avatarUrl: text } },
		replyId: nullableText, renoteId: nullableText,
		files: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
			id: text, name: text, type: text, size: integer, comment: nullableText, isSensitive: flag,
		} } },
		poll: { type: 'object', optional: false, nullable: true, properties: {
			choices: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: { text, votes: integer } } },
			expiresAt: nullableText, multiple: flag,
		} },
	},
} as const;

export const privateOptionsSchema = {
	mode: { type: 'string', enum: ['home', 'search', 'profile', 'show', 'validate'], default: 'home' },
	contextMode: { type: 'string', enum: ['home', 'search', 'profile', 'show'] },
	query: { type: 'string', minLength: 1, maxLength: 200 },
	userId: { type: 'string', format: 'misskey:id', maxLength: 32 },
	noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } },
	rangeStartAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
	rangeEndAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
	withReplies: { type: 'boolean', default: true }, withRenotes: { type: 'boolean', default: true },
	withFiles: { type: 'boolean', default: false }, withChannelNotes: { type: 'boolean', default: true },
} as const;
