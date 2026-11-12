/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import type { ReactionPreview } from './reaction-protocol.js';

export type PrivateOptions = {
	mode: 'home' | 'search' | 'profile' | 'show' | 'channel' | 'validate';
	contextMode?: 'home' | 'search' | 'profile' | 'show' | 'channel';
	channelId?: string;
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
	channelId?: string | null;
	canDelete?: boolean;
	emojis?: Record<string, string>; reactions?: Record<string, number>; reactionEmojis?: Record<string, string>; myReaction?: string | null;
	myReactions?: string[]; extendedReactions?: boolean;
	reactionPreviews?: ReactionPreview[];
	replyId: string | null; renoteId: string | null;
	files: { id: string; name: string; type: string; size: number; comment: string | null; isSensitive: boolean }[];
	poll: { choices: { text: string; votes: number; isVoted?: boolean }[]; expiresAt: string | null; multiple: boolean } | null;
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
		channelId: { ...nullableText, optional: true },
		canDelete: { ...flag, optional: true },
		author: { type: 'object', optional: false, nullable: false, properties: { name: nullableText, username: text, host: text, uri: text, avatarUrl: text } },
		emojis: { type: 'object', optional: true, nullable: false, additionalProperties: text },
		reactions: { type: 'object', optional: true, nullable: false, additionalProperties: integer },
		reactionEmojis: { type: 'object', optional: true, nullable: false, additionalProperties: text },
		myReaction: { ...nullableText, optional: true },
		myReactions: { type: 'array', optional: true, nullable: false, items: text },
		reactionPreviews: { type: 'array', optional: true, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
			reaction: text, account: { type: 'object', optional: false, nullable: false, properties: { name: nullableText, username: text, host: text, uri: text, avatarUrl: text } },
		} } },
		extendedReactions: { ...flag, optional: true },
		replyId: nullableText, renoteId: nullableText,
		files: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
			id: text, name: text, type: text, size: integer, comment: nullableText, isSensitive: flag,
		} } },
		poll: { type: 'object', optional: false, nullable: true, properties: {
			choices: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: { text, votes: integer, isVoted: { ...flag, optional: true } } } },
			expiresAt: nullableText, multiple: flag,
		} },
	},
} as const;

export const privateOptionsSchema = {
	mode: { type: 'string', enum: ['home', 'search', 'profile', 'show', 'channel', 'validate'], default: 'home' },
	contextMode: { type: 'string', enum: ['home', 'search', 'profile', 'show', 'channel'] },
	channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	query: { type: 'string', minLength: 1, maxLength: 200 },
	userId: { type: 'string', format: 'misskey:id', maxLength: 32 },
	noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } },
	rangeStartAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
	rangeEndAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
	withReplies: { type: 'boolean', default: true }, withRenotes: { type: 'boolean', default: true },
	withFiles: { type: 'boolean', default: false }, withChannelNotes: { type: 'boolean', default: true },
} as const;
