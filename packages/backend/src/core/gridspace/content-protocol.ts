/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';

export const contentOptionsSchema = {
	kind: { type: 'string', enum: ['pages', 'gallery'] },
	mode: { type: 'string', enum: ['recent', 'featured'], default: 'recent' },
	userId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	itemId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	after: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	before: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	sinceDate: { type: 'integer', minimum: 1 },
	untilDate: { type: 'integer', minimum: 1 },
	limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 },
} as const;
export type ContentOptions = { kind: 'pages' | 'gallery'; mode?: 'recent' | 'featured'; userId?: string; itemId?: string; before?: string; after?: string; sinceDate?: number; untilDate?: number; limit?: number };
export type ContentPage = { origin: string | null; pages: Packed<'Page'>[]; gallery: Packed<'GalleryPost'>[]; next: string | null };
export const contentPageSchema = {
	type: 'object', optional: false, nullable: false, properties: {
		origin: { type: 'string', optional: false, nullable: true },
		pages: { type: 'array', optional: false, nullable: false, items: { type: 'object', ref: 'Page', optional: false, nullable: false } },
		gallery: { type: 'array', optional: false, nullable: false, items: { type: 'object', ref: 'GalleryPost', optional: false, nullable: false } },
		next: { type: 'string', optional: false, nullable: true },
	},
} as const;
