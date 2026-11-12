/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { NotificationService } from '@/core/NotificationService.js';
import { NotificationReadService } from '@/core/NotificationReadService.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import type { MiNotification } from '@/models/Notification.js';
import type { Packed } from '@/misc/json-schema.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import type { NotificationOptions, NotificationPeerRequest, NotificationPage, WireNotification, LocalNotification, PeerNotification } from './notification-protocol.js';

@Injectable()
export class GridspaceNotificationService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.db) private db: DataSource,
		private notifications: NotificationService,
		private reads: NotificationReadService,
		private packer: NotificationEntityService,
		private links: GridspaceLinkService,
		private notes: GridspacePrivateService,
		private search: GridspaceSearchService,
	) {}

	private async raw(userId: string, input: NotificationOptions) {
		if (input.countOnly) return [];
		if (input.ids) {
			return (await Promise.all(input.ids.map(id => this.notifications.getNotification(userId, id)))).filter((n): n is MiNotification => n != null);
		}
		return this.notifications.getNotifications(userId, { untilId: input.before, sinceId: input.since, limit: input.limit ?? 20 });
	}

	private page<T>(rows: MiNotification[], items: T[], userId: string, unreadCount: number, input: NotificationOptions): NotificationPage<T> {
		return { items, unreadCount, origin: this.config.url, recipientId: userId,
			next: rows.length === (input.limit ?? 20) && !input.ids ? rows.at(-1)!.id : null,
			newest: (input.since ? rows.at(-1)?.id : rows[0]?.id) ?? null, boundary: rows.at(-1)?.createdAt ? new Date(rows.at(-1)!.createdAt).toISOString() : null };
	}

	public async local(user: MiLocalUser, input: NotificationOptions): Promise<NotificationPage<LocalNotification>> {
		const rows = await this.raw(user.id, input);
		const packed = await this.packer.packMany(rows.filter(n => !input.excludeTypes?.includes(n.type)), user.id) as unknown as Packed<'Notification'>[];
		const state = await this.reads.state(user.id, packed.map(n => n.id));
		return this.page(rows, packed.map((notification, i) => ({ id: notification.id, createdAt: notification.createdAt, isRead: state.isRead[i], notification })), user.id, state.unreadCount, input);
	}

	private async authorize(input: NotificationPeerRequest) {
		const link = await this.links.authorizePrivate(input);
		if (!await this.links.hasNotificationScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return link;
	}

	public async peer(action: string, input: NotificationPeerRequest): Promise<NotificationPage<WireNotification>> {
		const link = await this.authorize(input);
		if (action === 'read') {
			if (!input.ids?.length) throw new GridspaceLinkError('INVALID_REQUEST');
			const state = await this.notifications.readNotifications(link.localUserId, input.ids);
			return this.page([], [], link.localUserId, state.unreadCount, input);
		}
		const rows = await this.raw(link.localUserId, input);
		const valid = await this.packer.packMany(rows.filter(n => !input.excludeTypes?.includes(n.type)), link.localUserId) as unknown as Packed<'Notification'>[];
		const noteIds = rows.flatMap(n => 'noteId' in n ? [n.noteId] : []);
		const items: WireNotification[] = [];
		for (const packed of valid) {
			const raw = rows.find(n => n.id === packed.id)!;
			const actor = 'notifierId' in raw ? await this.search.userQuery({ id: link.localUserId }).andWhere('user.id = :id', { id: raw.notifierId }).getOne() : null;
			if ('notifierId' in raw && !actor) continue;
			items.push({ id: raw.id, createdAt: new Date(raw.createdAt).toISOString(), type: raw.type, isRead: false, note: null,
				user: actor ? { name: actor.name, username: actor.username, host: actor.host ?? new URL(this.config.url).host, uri: actor.uri ?? `${this.config.url}/users/${actor.id}` } : null,
				body: raw.type === 'app' ? [raw.customHeader, raw.customBody].filter(Boolean).join('\n') : raw.type === 'followRequestAccepted' ? raw.message : null,
				reaction: raw.type === 'reaction' ? raw.reaction : null });
		}
		// Pack protected bodies last, after notifier lookups. peerNotes rechecks
		// the note audience/deletion and grant after its own asynchronous work.
		const notes = noteIds.length ? (await this.notes.peerNotes({ ...input, mode: 'validate', contextMode: 'show', ids: [...new Set(noteIds)] })).notes : [];
		const visible = items.filter(item => {
			const raw = rows.find(n => n.id === item.id)!;
			if (!('noteId' in raw)) return true;
			item.note = notes.find(n => n.id === raw.noteId) ?? null;
			return item.note != null;
		});
		await this.authorize(input);
		const state = await this.reads.state(link.localUserId, visible.map(n => n.id));
		visible.forEach((n, i) => { n.isRead = state.isRead[i]; });
		return this.page(rows, visible, link.localUserId, state.unreadCount, input);
	}

	public async remote(user: MiLocalUser, input: NotificationOptions, action = 'query'): Promise<NotificationPage<PeerNotification>> {
		const link = await this.links.privateLink(user.id);
		// Endpoint inputs can contain login credentials and unknown properties.
		// Only the documented query fields may cross the server boundary.
		const options: NotificationOptions = { before: input.before, since: input.since, ids: input.ids, excludeTypes: input.excludeTypes, limit: input.limit, countOnly: input.countOnly };
		const page = await this.links.json<NotificationPage<WireNotification>>(`/gridspace/v1/notifications/${action}`, { ...options, ...this.links.privateCredential(link) });
		if (page.origin !== link.peerOrigin || page.recipientId !== link.peerUserId || !Array.isArray(page.items) || page.items.length > 100) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const items: PeerNotification[] = [];
		for (const item of page.items) {
			if (item.user && !await this.notes.localActorAllows(user, item.user)) continue;
			if (item.note && !await this.notes.localAllows(user, item.note, false, link.peerUserId)) continue;
			const note = item.note ? (({ filterActors: _, ...display }) => display)(item.note) : null;
			items.push({ ...item, note });
		}
		await this.links.checkPrivateUnchanged(link);
		return { ...page, items };
	}
}
