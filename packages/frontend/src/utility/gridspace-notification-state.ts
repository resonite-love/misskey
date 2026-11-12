/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, reactive } from 'vue';
import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';

// Counts only, never notification bodies. A failed peer query is unknown, not zero.
export const linkedNotifications = reactive({ checked: false, statusKnown: false, enabled: false, available: true, count: null as number | null, origin: '', peerRole: null as 'source' | 'client' | null });
export const notificationCount = computed(() => ($i?.unreadNotificationsCount ?? 0) + (linkedNotifications.count ?? 0));
export const notificationIndicator = computed(() => notificationCount.value > 0 || (linkedNotifications.enabled && !linkedNotifications.available));
export const notificationBadge = computed(() => linkedNotifications.enabled && !linkedNotifications.available ? `${notificationCount.value || ''}?` : notificationCount.value > 99 ? '99+' : notificationCount.value ? String(notificationCount.value) : '');
export const legacyNotificationsReady = computed(() => linkedNotifications.statusKnown && !linkedNotifications.enabled);
let countRevision = 0;
export function setLinkedNotificationCount(value: number) {
	countRevision++;
	linkedNotifications.count = value;
	linkedNotifications.available = true;
}
let working = false;
let started = false;

export async function refreshLinkedNotifications() {
	if (!$i || working || window.document.hidden) return;
	working = true;
	try {
		const status = await misskeyApi('gridspace/private-grant', {}, undefined, AbortSignal.timeout(15000));
		linkedNotifications.origin = status.peerOrigin ?? '';
		linkedNotifications.peerRole = status.peerRole;
		if (!status.available) throw new Error('Peer unavailable');
		linkedNotifications.statusKnown = true;
		linkedNotifications.enabled = status.canReadNotifications;
		linkedNotifications.available = true;
		if (!status.canReadNotifications) linkedNotifications.count = null;
		if (status.canReadNotifications) {
			const revision = countRevision;
			const page = await misskeyApi('gridspace/notifications', { source: 'peer', countOnly: true }, undefined, AbortSignal.timeout(15000));
			if (revision === countRevision) setLinkedNotificationCount(page.unreadCount);
		}
	} catch { linkedNotifications.available = false; } finally {
		linkedNotifications.checked = true; working = false;
	}
}

export function startLinkedNotificationCounts() {
	if (started) return;
	started = true;
	void refreshLinkedNotifications();
	window.setInterval(() => { void refreshLinkedNotifications(); }, 15000);
	window.document.addEventListener('visibilitychange', () => { if (!window.document.hidden) void refreshLinkedNotifications(); });
}
