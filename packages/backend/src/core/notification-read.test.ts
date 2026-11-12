/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NotificationService } from './NotificationService.js';

describe('notification read events', () => {
	test('sends read events and web push only when unread state changes, unless forced', async () => {
		const state = vi.fn().mockResolvedValue({ unreadCount: 0, changed: false, isRead: [] });
		const publishMainStream = vi.fn();
		const pushNotification = vi.fn();
		const service: NotificationService = Object.assign(Object.create(NotificationService.prototype), {
			reads: { state }, globalEventService: { publishMainStream }, pushNotificationService: { pushNotification },
		});
		await service.readAllNotification('viewer');
		await service.readNotifications('viewer', ['already-read']);
		expect(publishMainStream).not.toHaveBeenCalled();
		expect(pushNotification).not.toHaveBeenCalled();
		state.mockResolvedValue({ unreadCount: 0, changed: true, isRead: [] });
		await service.readNotifications('viewer', ['newly-read']);
		expect(publishMainStream).toHaveBeenCalledWith('viewer', 'notificationRead', { unreadCount: 0 });
		expect(pushNotification).toHaveBeenCalledTimes(1);
		state.mockResolvedValue({ unreadCount: 0, changed: false, isRead: [] });
		await service.readAllNotification('viewer', true);
		expect(pushNotification).toHaveBeenCalledTimes(2);
	});
});
