/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const text = { type: 'string', optional: false, nullable: false } as const;
const nullableText = { ...text, nullable: true } as const;
const count = { type: 'integer', optional: false, nullable: false } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;

export const adminStatusSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		enabled: flag, origin: text, peerOrigin: nullableText, checkedAt: text,
		connection: { ...text, enum: ['ok', 'unavailable', 'incompatible', 'disabled'] },
		latencyMs: { ...count, nullable: true },
		linksActive: count, linksPreparing: count, linksRevoked: count, linksWithErrors: count,
		importsPending: count, importsFailed: count, importsRequested: count,
		expansionsPending: count, expansionsRetrying: count, deliveriesPending: count, deliveriesRetrying: count,
		revocationsPending: count, privateRevocationsPending: count,
	},
} as const;

export const adminLinkSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		id: text, localUserId: text, localUsername: text, peerUserId: text, peerUsername: text,
		peerOrigin: text, generation: count, state: text, initiator: flag, lastError: nullableText,
		createdAt: text, privateReadEnabled: flag, privateRevocationPending: flag,
	},
} as const;

export const adminJobKinds = ['import', 'expansion', 'delivery'] as const;
export type AdminJobKind = typeof adminJobKinds[number];
export type AdminJob = {
	id: string; kind: AdminJobKind; localUserId: string | null; localUsername: string | null;
	target: string | null; state: string; reason: string | null; attempts: number;
	retryAt: string | null; generation: number | null; version: string | null; canRetry: boolean;
};
export type AdminRetry = { kind: AdminJobKind; id: string; generation?: number; version?: string };
export const adminJobSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		id: text, kind: { ...text, enum: adminJobKinds }, localUserId: nullableText, localUsername: nullableText,
		target: nullableText, state: text, reason: nullableText, attempts: count, retryAt: nullableText,
		generation: { ...count, nullable: true }, version: nullableText, canRetry: flag,
	},
} as const;

/** Queue rows never contain source payloads or credentials. */
export function adminReason(value: string | null): string | null {
	return value && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : value ? 'UNKNOWN' : null;
}
