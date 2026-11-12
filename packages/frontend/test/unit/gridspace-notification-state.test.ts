/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedNotifications, legacyNotificationsReady, refreshLinkedNotifications, setLinkedNotificationCount } from '@/utility/gridspace-notification-state.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', unreadNotificationsCount: 0 } }));
const api = vi.mocked(misskeyApi);
beforeEach(() => { api.mockReset(); Object.assign(linkedNotifications, { checked: false, statusKnown: false, enabled: false, available: true, count: null, origin: '' }); });
afterEach(() => vi.restoreAllMocks());

describe('linked notification counts', () => {
	it('allows ordinary notifications after confirming no notification grant', async () => {
		api.mockResolvedValue({ available: true, canReadNotifications: false } as never);
		await refreshLinkedNotifications();
		expect(legacyNotificationsReady.value).toBe(true);
		expect(linkedNotifications.available).toBe(true);
	});
	it('does not replace a confirmed read count with an older in-flight query', async () => {
		let release!: (page: { unreadCount: number }) => void;
		api.mockImplementation((async endpoint => endpoint === 'gridspace/private-grant'
			? { available: true, canReadNotifications: true }
			: new Promise<{ unreadCount: number }>(resolve => { release = resolve; })) as typeof misskeyApi);
		const pending = refreshLinkedNotifications();
		await Promise.resolve(); await Promise.resolve();
		setLinkedNotificationCount(0);
		release({ unreadCount: 7 }); await pending;
		expect(linkedNotifications.count).toBe(0);
	});
	it('does not invent a link when initial status lookup fails', async () => {
		api.mockRejectedValue(new Error('offline'));
		await refreshLinkedNotifications();
		expect(linkedNotifications.enabled).toBe(false);
		expect(linkedNotifications.checked).toBe(true);
		expect(legacyNotificationsReady.value).toBe(false);
	});
	it('retains the last count during refresh and a transient failure', async () => {
		Object.assign(linkedNotifications, { checked: true, enabled: true, count: 7 });
		let reject!: (error: Error) => void;
		api.mockImplementation((async endpoint => endpoint === 'gridspace/private-grant'
			? { available: true, canReadNotifications: true, peerOrigin: 'https://r.example' }
			: new Promise((_resolve, fail) => { reject = fail; })) as typeof misskeyApi);
		const pending = refreshLinkedNotifications();
		await Promise.resolve(); await Promise.resolve();
		expect(linkedNotifications.count).toBe(7);
		reject(new Error('offline')); await pending;
		expect(linkedNotifications.count).toBe(7);
		expect(linkedNotifications.available).toBe(false);
	});
});
