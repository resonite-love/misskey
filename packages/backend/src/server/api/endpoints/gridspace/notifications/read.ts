/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { NotificationService } from '@/core/NotificationService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceNotificationService } from '@/core/gridspace/GridspaceNotificationService.js';
import { notificationOptionsSchema } from '@/core/gridspace/notification-protocol.js';

export const meta = {
	tags: ['notifications'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 180 },
	errors: { unavailable: { message: 'Notification read update failed.', code: 'GRIDSPACE_NOTIFICATIONS_UNAVAILABLE', id: 'c8c0d244-6abd-4daa-a4b0-aa955cbe84e6' } },
	res: { type: 'object', optional: false, nullable: false, properties: { unreadCount: { type: 'integer', optional: false, nullable: false } } },
} as const;
export const paramDef = { type: 'object', properties: { source: { type: 'string', enum: ['local', 'peer'], default: 'local' }, ids: notificationOptionsSchema.ids }, required: ['ids'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private notifications: GridspaceNotificationService, private local: NotificationService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const result = ps.source === 'peer' ? await this.notifications.remote(me, { ids: ps.ids }, 'read') : await this.local.readNotifications(me.id, ps.ids);
				return { unreadCount: result.unreadCount };
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
