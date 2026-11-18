/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';

export type SyncEmoji = {
	id: string; name: string; originalUrl: string; imageHash: string | null;
	category: string | null; aliases: string[]; license: string | null;
	isSensitive: boolean; localOnly: boolean; restricted: boolean; hash: string;
};
export type EmojiManifest = { origin: string; revision: string; emojis?: SyncEmoji[] };
export type EmojiSyncAction = 'status' | 'retry' | 'preferA' | 'preferB' | 'ignore' | 'resume';
export type EmojiSyncRequest = { action: EmojiSyncAction; id?: string; after?: string; expectedA?: string | null; expectedB?: string | null };
export type EmojiApply = { action: 'apply'; operationId: string; targetId: string | null; expected: string | null; emoji: SyncEmoji };
export type EmojiPeerRequest = EmojiApply | EmojiSyncRequest | { action: 'manifest'; revision?: string };

export const emojiDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function emojiContent(emoji: Omit<SyncEmoji, 'hash'> | SyncEmoji) {
	return { name: emoji.name, image: emoji.imageHash ?? emoji.originalUrl, category: emoji.category, aliases: [...emoji.aliases].sort(), license: emoji.license, isSensitive: emoji.isSensitive, localOnly: emoji.localOnly, restricted: emoji.restricted };
}
export function sameEmoji(a: SyncEmoji, b: SyncEmoji): boolean {
	return JSON.stringify(emojiContent(a)) === JSON.stringify(emojiContent(b));
}
export type EmojiDecision = 'same' | 'toA' | 'toB' | 'conflict' | 'removed' | 'restricted' | 'unchanged';
export function decideEmoji(a: SyncEmoji | undefined, b: SyncEmoji | undefined, beforeA: string | null, beforeB: string | null): EmojiDecision {
	if (a?.restricted || b?.restricted) return 'restricted';
	if (a && b && sameEmoji(a, b)) return 'same';
	if (!a && !b) return 'removed';
	if (!a) return beforeA ? 'removed' : 'toA';
	if (!b) return beforeB ? 'removed' : 'toB';
	if (!beforeA || !beforeB) return 'conflict';
	const changedA = a.hash !== beforeA, changedB = b.hash !== beforeB;
	if (changedA && changedB) return 'conflict';
	return changedA ? 'toB' : changedB ? 'toA' : 'unchanged';
}

const nullableText = (maxLength: number) => ({ type: 'string', nullable: true, maxLength } as const);
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const emojiSchema = {
	type: 'object', additionalProperties: false,
	required: ['id', 'name', 'originalUrl', 'imageHash', 'category', 'aliases', 'license', 'isSensitive', 'localOnly', 'restricted', 'hash'],
	properties: {
		id: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, name: { type: 'string', pattern: '^[-a-zA-Z0-9_]{1,128}$' },
		originalUrl: { type: 'string', maxLength: 512, minLength: 1 }, imageHash: { type: 'string', nullable: true, pattern: '^[a-f0-9]{32}$' },
		category: nullableText(128), license: nullableText(1024), aliases: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 128 } },
		isSensitive: { type: 'boolean' }, localOnly: { type: 'boolean' }, restricted: { type: 'boolean' }, hash: digestSchema,
	},
} as const;
export const emojiPeerSchema = {
	type: 'object', additionalProperties: false, required: ['action'],
	properties: {
		action: { type: 'string', enum: ['manifest', 'apply', 'status', 'retry', 'preferA', 'preferB', 'ignore', 'resume'] },
		revision: digestSchema, id: { type: 'string', format: 'uuid' }, after: { type: 'string', format: 'uuid' }, expectedA: { ...digestSchema, nullable: true }, expectedB: { ...digestSchema, nullable: true },
		operationId: digestSchema, targetId: { type: 'string', nullable: true, pattern: '^[a-zA-Z0-9]{1,32}$' }, expected: { ...digestSchema, nullable: true }, emoji: emojiSchema,
	},
	allOf: [{ if: { properties: { action: { const: 'apply' } } }, then: { required: ['operationId', 'targetId', 'expected', 'emoji'] } },
									{ if: { properties: { action: { enum: ['preferA', 'preferB', 'ignore', 'resume'] } } }, then: { required: ['id', 'expectedA', 'expectedB'] } }],
} as const;
