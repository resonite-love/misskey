/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { NotificationService } from '@/core/NotificationService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceNotificationService } from '@/core/gridspace/GridspaceNotificationService.js';
import { notificationOptionsSchema } from '@/core/gridspace/notification-protocol.js';

export const meta = {
	tags: ['notifications'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 180 },
	errors: { invalidRequest: { message: 'Specify notification IDs or all=true.', code: 'INVALID_PARAM', id: '18329eb1-8f01-45fc-ab82-a3240bc419e1' }, unavailable: { message: 'Notification read update failed.', code: 'GRIDSPACE_NOTIFICATIONS_UNAVAILABLE', id: 'c8c0d244-6abd-4daa-a4b0-aa955cbe84e6' } },
	res: { type: 'object', optional: false, nullable: false, properties: { unreadCount: { type: 'integer', optional: false, nullable: false } } },
} as const;
export const paramDef = { type: 'object', properties: { source: { type: 'string', enum: ['local', 'peer', 'channel'], default: 'local' }, ids: notificationOptionsSchema.ids, all: { type: 'boolean', default: false }, origin: { type: 'string', maxLength: 512 }, recipientId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } }, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private notifications: GridspaceNotificationService, private local: NotificationService, @Inject(DI.config) private config: Config) {
		super(meta, paramDef, async (ps, me) => {
			if (!ps.all && !ps.ids?.length) throw new ApiError(meta.errors.invalidRequest);
			try {
				if (ps.source === 'local' && ((ps.origin && ps.origin !== this.config.url) || (ps.recipientId && ps.recipientId !== me.id))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				const result = ps.source !== 'local' ? await this.notifications.remote(me, { ids: ps.ids, expectedOrigin: ps.origin, expectedRecipientId: ps.recipientId }, ps.all ? 'read-all' : 'read', ps.source === 'channel')
					: ps.all ? await this.local.readAllNotification(me.id) : await this.local.readNotifications(me.id, ps.ids!);
				return { unreadCount: result.unreadCount };
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
