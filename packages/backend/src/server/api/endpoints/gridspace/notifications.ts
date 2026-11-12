/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceNotificationService } from '@/core/gridspace/GridspaceNotificationService.js';
import { notificationOptionsSchema, peerNotificationSchema } from '@/core/gridspace/notification-protocol.js';

const text = { type: 'string', optional: false, nullable: false } as const;
export const meta = {
	tags: ['notifications'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 180 },
	errors: { unavailable: { message: 'Notifications are unavailable.', code: 'GRIDSPACE_NOTIFICATIONS_UNAVAILABLE', id: 'b2ea7da9-e82a-4b45-9861-aa6e01b8b200' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		origin: text, recipientId: text, next: { ...text, nullable: true }, newest: { ...text, nullable: true }, boundary: { ...text, nullable: true },
		unreadCount: { type: 'integer', optional: false, nullable: false },
		local: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
			id: text, createdAt: text, isRead: { type: 'boolean', optional: false, nullable: false }, notification: { type: 'object', optional: false, nullable: false, ref: 'Notification' },
		} } },
		remote: { type: 'array', optional: false, nullable: false, items: peerNotificationSchema },
	} },
} as const;
export const paramDef = { type: 'object', properties: { ...notificationOptionsSchema, source: { type: 'string', enum: ['local', 'peer'], default: 'local' } }, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private notifications: GridspaceNotificationService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				if (ps.source === 'peer') {
					const { items, ...page } = await this.notifications.remote(me, ps);
					return { ...page, local: [], remote: items };
				}
				const { items, ...page } = await this.notifications.local(me, ps);
				return { ...page, local: items, remote: [] };
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
