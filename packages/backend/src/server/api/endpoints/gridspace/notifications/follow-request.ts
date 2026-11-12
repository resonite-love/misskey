/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceNotificationService } from '@/core/gridspace/GridspaceNotificationService.js';

export const meta = {
	tags: ['notifications'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'Follow request could not be processed.', code: 'GRIDSPACE_NOTIFICATION_ACTION_UNAVAILABLE', id: '9d196789-a1c7-4196-bdd0-8c5ae8272e2c' } },
	res: { type: 'object', optional: false, nullable: false, properties: { done: { type: 'boolean', optional: false, nullable: false } } },
} as const;
export const paramDef = { type: 'object', properties: {
	notificationId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	followRequestId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	accept: { type: 'boolean' },
}, required: ['notificationId', 'followRequestId', 'accept'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private notifications: GridspaceNotificationService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.notifications.decide(me, ps.notificationId, ps.followRequestId, ps.accept); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
