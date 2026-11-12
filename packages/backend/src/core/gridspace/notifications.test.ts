/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiGridspaceLink } from '@/models/Gridspace.js';
import type { NotificationService } from '@/core/NotificationService.js';
import type { NotificationReadService } from '@/core/NotificationReadService.js';
import type { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { GridspaceNotificationService } from './GridspaceNotificationService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceSearchService } from './GridspaceSearchService.js';
import type { NotificationOptions, WireNotification } from './notification-protocol.js';

function fixture() {
	const links = mockDeep<GridspaceLinkService>();
	const notes = mockDeep<GridspacePrivateService>();
	const notifications = mockDeep<NotificationService>();
	const reads = mockDeep<NotificationReadService>();
	const packer = mockDeep<NotificationEntityService>();
	const link = { peerOrigin: 'https://r.example', peerUserId: 'old', localUserId: 'viewer' } as MiGridspaceLink;
	links.privateLink.mockResolvedValue(link);
	links.authorizePrivate.mockResolvedValue(link);
	links.privateCredential.mockReturnValue({ accessToken: 'pair-token', linkId: 'real-link', localUserId: 'viewer', generation: 2 });
	notes.localActorAllows.mockResolvedValue(true); notes.localAllows.mockResolvedValue(true);
	const db = mockDeep<DataSource>();
	db.transaction.mockImplementation((async (run: (manager: EntityManager) => Promise<unknown>) => run(db.manager)) as DataSource['transaction']);
	const service = new GridspaceNotificationService({ url: 'https://g.example' } as Config, db, notifications, reads, packer, links, notes, mockDeep<GridspaceSearchService>());
	return { service, links, notes, notifications, reads, packer, viewer: { id: 'viewer' } as MiLocalUser };
}

describe('GridSpace notifications', () => {
	test('never forwards caller secrets or allows caller-supplied binding overrides', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ items: [], origin: 'https://r.example', recipientId: 'old' });
		await f.service.remote(f.viewer, { i: 'login-secret', accessToken: 'evil', linkId: 'wrong', source: 'peer', before: 'cursor' } as NotificationOptions);
		const body = f.links.json.mock.calls[0][1];
		expect(body).not.toHaveProperty('i'); expect(body).not.toHaveProperty('source');
		expect(body).toMatchObject({ accessToken: 'pair-token', linkId: 'real-link', before: 'cursor', generation: 2 });
	});
	test('requires notification consent in addition to the linked private-reader grant', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(false);
		await expect(f.service.peer('query', {})).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		await expect(f.service.peer('read', { ids: ['id'] })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.notifications.readNotifications).not.toHaveBeenCalled();
	});
	test('checks uncached notifier host/mutes even for notifications without a note', async () => {
		const f = fixture(); f.notes.localActorAllows.mockResolvedValue(false);
		f.links.json.mockResolvedValue({ items: [{ id: 'follow', user: { host: 'muted.example' }, note: null }], origin: 'https://r.example', recipientId: 'old' });
		expect((await f.service.remote(f.viewer, {})).items).toEqual([]);
		expect(f.notes.localActorAllows).toHaveBeenCalled();
	});
	test('rejects a response for another recipient or origin', async () => {
		const f = fixture();
		for (const patch of [{ origin: 'https://elsewhere.example' }, { recipientId: 'another' }]) {
			f.links.json.mockResolvedValue({ items: [], origin: 'https://r.example', recipientId: 'old', ...patch });
			await expect(f.service.remote(f.viewer, {})).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
		}
	});
	test('does not mark anything read when querying, including an excluded page', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		f.notifications.getNotifications.mockResolvedValue([{ id: 'test', createdAt: '2026-11-12T00:00:00Z', type: 'test' }]);
		f.packer.packMany.mockResolvedValue([]); f.reads.state.mockResolvedValue({ unreadCount: 1, changed: false, isRead: [] });
		const result = await f.service.peer('query', { excludeTypes: ['test'], limit: 1 });
		expect(result.items).toEqual([]); expect(result.next).toBe('test'); expect(result.unreadCount).toBe(1);
		expect(f.notifications.readNotifications).not.toHaveBeenCalled();
	});
	test('rechecks the local grant after fetching and filtering', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ items: [] as WireNotification[], origin: 'https://r.example', recipientId: 'old' });
		f.links.checkPrivateUnchanged.mockRejectedValue(new Error('revoked'));
		await expect(f.service.remote(f.viewer, {})).rejects.toThrow('revoked');
	});
	test('all-read requires a current write grant and is never inferred from query options', async () => {
		const f = fixture(); f.links.hasNotificationScope.mockResolvedValue(true);
		f.notifications.readAllNotification.mockResolvedValue({ unreadCount: 0, changed: true, isRead: [] });
		expect((await f.service.peer('read-all', {})).unreadCount).toBe(0);
		expect(f.links.lockReplyAuthorization).toHaveBeenCalled();
		expect(f.notifications.readAllNotification).toHaveBeenCalledWith('viewer');
		f.notifications.readAllNotification.mockClear();
		f.links.lockReplyAuthorization.mockRejectedValue(new Error('revoked while waiting'));
		await expect(f.service.peer('read-all', {})).rejects.toThrow('revoked while waiting');
		expect(f.notifications.readAllNotification).not.toHaveBeenCalled();
	});
});
