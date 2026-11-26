/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const count = { type: 'integer', optional: false, nullable: false, minimum: 0 } as const;

export const resonitePackageSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		schemaVersion: { type: 'integer', optional: false, nullable: false, minimum: 1, maximum: 1 },
		name: { type: 'string', optional: false, nullable: false },
		description: { type: 'string', optional: true, nullable: false },
		recordCount: count,
		assetCount: count,
		assetBytes: count,
		unpackedBytes: count,
		variantCount: count,
		slotCount: { ...count, optional: true },
		componentCount: { ...count, optional: true },
		thumbnailDataUrl: { type: 'string', optional: true, nullable: false },
	},
} as const;
