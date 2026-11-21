/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceNotificationTimelineService, notificationSources } from '@/core/gridspace/GridspaceNotificationTimelineService.js';
import { peerNotificationSchema } from '@/core/gridspace/notification-protocol.js';

const text = { type: 'string', optional: false, nullable: false } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
export const meta = {
	tags: ['notifications'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 180 },
	errors: { unavailable: { message: 'Notification timeline is unavailable.', code: 'GRIDSPACE_NOTIFICATION_TIMELINE_UNAVAILABLE', id: '448dd862-bbbf-44e0-8903-6c0e834a359a' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		version: { type: 'integer', optional: false, nullable: false }, scannedCount: { type: 'integer', optional: false, nullable: false }, cursor: text, nextCursor: { ...text, nullable: true }, complete: flag,
		revalidateAfterMs: { type: 'integer', optional: false, nullable: false },
		items: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
			key: text, source: { ...text, enum: notificationSources }, origin: text, recipientId: text, id: text, createdAt: text, isRead: flag,
			local: { type: 'object', optional: false, nullable: true, ref: 'Notification' }, remote: { ...peerNotificationSchema, nullable: true },
		} } },
		sources: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
			source: { ...text, enum: notificationSources }, status: { ...text, enum: ['ok', 'disabled', 'unavailable', 'unauthorized'] }, retryable: flag, unreadCount: { type: 'integer', optional: false, nullable: true },
		} } },
	} },
} as const;
export const paramDef = {
	type: 'object', properties: {
		mode: { type: 'string', enum: ['page', 'refresh', 'validate'], default: 'page' },
		cursor: { type: 'string', minLength: 100, maxLength: 160 },
		limit: { type: 'integer', minimum: 1, maximum: 40, default: 20 },
		count: { type: 'integer', minimum: 1, maximum: 6000 },
		excludeTypes: { type: 'array', maxItems: 40, uniqueItems: true, items: { type: 'string', maxLength: 64 } },
	}, required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private timeline: GridspaceNotificationTimelineService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.timeline.read(me, ps); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
