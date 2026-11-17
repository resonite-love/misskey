/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';
import { privateNoteSchema, type PrivateNote } from '../private-protocol.js';

// Push invalidations normally renew authorization first. The bounded lease and
// periodic recovery still fail closed if either server or the stream is lost.
export const TIMELINE_AUTHORIZATION_TTL_MS = 60_000;
export const TIMELINE_REVALIDATE_MS = 30_000;

export type TimelinePosition = { sortAt: string; canonicalUri: string; noteId?: string; sourceId?: string; source?: 'local' | 'peer' };
export type TimelineReference = TimelinePosition & { noteId: string; normalized: boolean; generation: number; source: 'local' | 'peer'; public?: boolean };
export type TimelineOptions = {
	kind: 'home' | 'social' | 'profile' | 'search' | 'mentions' | 'direct' | 'channel' | 'favorites' | 'antenna' | 'clip'; withReplies?: boolean; withRenotes?: boolean; withFiles?: boolean;
	includeMyRenotes?: boolean; includeRenotedMyNotes?: boolean; includeLocalRenotes?: boolean;
	channelId?: string; clipId?: string; antennaId?: string; userId?: string; query?: string;
	withChannelNotes?: boolean; order?: 'newest' | 'oldest'; rangeStartAt?: number; rangeEndAt?: number;
};
export type TimelineItem = {
	key: string; sortKey: { sortAt: string; uri: string }; ref: string;
	representation: 'normal' | 'delegated'; payload: Packed<'Note'> | PrivateNote;
	validForMs: number | null; nextPolicyCheckAt: string | null;
};
export type TimelineSourceState = { source: 'local' | 'peer'; status: 'ok' | 'unavailable' | 'unauthorized' | 'disabled'; retryable: boolean };
export type TimelinePage = {
	version: 1; session: string; revision: string; items: TimelineItem[]; nextCursor: string | null; updatesCursor: string;
	complete: boolean; mode: 'unified' | 'local-fallback'; sources: TimelineSourceState[]; revalidateAfterMs: number;
	retainedItems?: TimelineItem[]; order?: string[];
};

export const timelineFilterSchema = {
	kind: { type: 'string', enum: ['home', 'social', 'profile', 'search', 'mentions', 'direct', 'channel', 'favorites', 'antenna', 'clip'] },
	channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	clipId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, antennaId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	userId: { type: 'string', format: 'misskey:id', maxLength: 32 },
	query: { type: 'string', minLength: 1, maxLength: 200 },
	withChannelNotes: { type: 'boolean', default: true }, order: { type: 'string', enum: ['newest', 'oldest'] },
	rangeStartAt: { type: 'integer', minimum: 1, maximum: 4102444800000 }, rangeEndAt: { type: 'integer', minimum: 1, maximum: 4102444800000 },
	withReplies: { type: 'boolean', default: false }, withRenotes: { type: 'boolean', default: true }, withFiles: { type: 'boolean', default: false },
	includeMyRenotes: { type: 'boolean', default: true }, includeRenotedMyNotes: { type: 'boolean', default: true }, includeLocalRenotes: { type: 'boolean', default: true },
} as const;
const text = { type: 'string', optional: false, nullable: false } as const;
const boolean = { type: 'boolean', optional: false, nullable: false } as const;
export const timelineItemSchema = {
	type: 'object', optional: false, nullable: false, properties: {
		key: text, ref: text,
		sortKey: { type: 'object', optional: false, nullable: false, properties: { sortAt: text, uri: text } },
		representation: { ...text, enum: ['normal', 'delegated'] },
		payload: { oneOf: [{ type: 'object', ref: 'Note', optional: false, nullable: false }, privateNoteSchema], optional: false, nullable: false },
		validForMs: { type: 'integer', optional: false, nullable: true }, nextPolicyCheckAt: { ...text, nullable: true },
	},
} as const;
export const timelinePageProperties = {
	version: { type: 'integer', optional: false, nullable: false }, session: text, revision: text,
	items: { type: 'array', optional: false, nullable: false, items: timelineItemSchema },
	nextCursor: { ...text, nullable: true }, updatesCursor: text, complete: boolean,
	mode: { ...text, enum: ['unified', 'local-fallback'] },
	sources: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
		source: { ...text, enum: ['local', 'peer'] }, status: { ...text, enum: ['ok', 'unavailable', 'unauthorized', 'disabled'] }, retryable: boolean,
	} } },
	revalidateAfterMs: { type: 'integer', optional: false, nullable: false },
} as const;

/** UTF-8 byte ordering is PostgreSQL's COLLATE C, including non-ASCII URIs. */
export function compareTimelinePosition(a: TimelinePosition, b: TimelinePosition): number {
	const time = BigInt(b.sortAt) - BigInt(a.sortAt);
	if (time !== 0n) return time < 0n ? -1 : 1;
	if (a.source !== b.source) return a.source === 'local' ? -1 : 1;
	return Buffer.compare(Buffer.from(b.sourceId ?? b.noteId ?? b.canonicalUri), Buffer.from(a.sourceId ?? a.noteId ?? a.canonicalUri));
}
