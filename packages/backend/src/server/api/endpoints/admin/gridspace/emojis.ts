/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceEmojiSyncService } from '@/core/gridspace/GridspaceEmojiSyncService.js';

const text = { type: 'string', optional: false, nullable: false } as const;
const count = { type: 'integer', optional: false, nullable: false } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
const item = { type: 'object', optional: false, nullable: true, properties: {
	id: text, name: text, originalUrl: text, hash: text, category: { ...text, nullable: true }, license: { ...text, nullable: true },
	aliases: { type: 'array', optional: false, nullable: false, items: text }, isSensitive: flag, localOnly: flag, restricted: flag,
} } as const;
export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, secure: true,
	limit: { duration: 60_000, max: 60 },
	errors: { unavailable: { message: 'Emoji synchronization is unavailable or the emoji has changed.', code: 'EMOJI_SYNC_UNAVAILABLE', id: 'd181279d-f267-43df-9cb6-4b39f584e705' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		enabled: { type: 'boolean', optional: false, nullable: false }, originA: text, originB: { ...text, nullable: true },
		checkedAt: { ...text, nullable: true }, lastError: { ...text, nullable: true }, next: { ...text, nullable: true },
		counts: { type: 'object', optional: false, nullable: false, properties: { pending: count, synced: count, conflict: count, failed: count, ignored: count } },
		items: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: { id: text, state: text, reason: { ...text, nullable: true }, a: item, b: item, attempts: count, retryAt: text } } },
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	action: { type: 'string', enum: ['status', 'retry', 'preferA', 'preferB', 'ignore', 'resume'], default: 'status' },
	id: { type: 'string', format: 'uuid' }, after: { type: 'string', format: 'uuid' }, expectedA: { type: 'string', nullable: true, pattern: '^[a-f0-9]{64}$' }, expectedB: { type: 'string', nullable: true, pattern: '^[a-f0-9]{64}$' },
}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: GridspaceEmojiSyncService) {
		super(meta, paramDef, async ps => {
			try { return await service.admin(ps); } catch { throw new ApiError(meta.errors.unavailable); }
		});
	}
}
