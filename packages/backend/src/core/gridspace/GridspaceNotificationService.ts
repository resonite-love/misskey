/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { NotificationService } from '@/core/NotificationService.js';
import { NotificationReadService } from '@/core/NotificationReadService.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import type { MiNotification } from '@/models/Notification.js';
import type { Packed } from '@/misc/json-schema.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { canonicalReaction } from './reaction-protocol.js';
import { GRIDSPACE_NOTIFICATION_WRITE_SCOPE } from './link-crypto.js';
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
		private moduleRef: ModuleRef,
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
		if (action === 'accept-follow' || action === 'reject-follow') {
			if (input.ids?.length !== 1 || !input.followRequestId) throw new GridspaceLinkError('INVALID_REQUEST');
			const notification = await this.notifications.getNotification(link.localUserId, input.ids[0]);
			if (notification?.type !== 'receiveFollowRequest' || notification.followRequestId !== input.followRequestId) throw new GridspaceLinkError('ACTION_REJECTED');
			if (!await this.links.hasFollowRequestScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			try {
				const done = await this.moduleRef.get(UserFollowingService).decideAuthorizedFollowRequest(link.localUserId, notification.notifierId, input.followRequestId, action === 'accept-follow', manager => this.links.lockReplyAuthorization(input, manager, 'write:following'));
				if (!done) throw new GridspaceLinkError('ACTION_REJECTED');
			} catch (error) {
				if (error instanceof IdentifiableError && error.id === 'gridspace-follow-decision-rejected') throw new GridspaceLinkError('ACTION_REJECTED');
				throw error;
			}
			const state = await this.reads.state(link.localUserId, []);
			return this.page([], [], link.localUserId, state.unreadCount, input);
		}
		if (action === 'read' || action === 'read-all') {
			if (action === 'read' && !input.ids?.length) throw new GridspaceLinkError('INVALID_REQUEST');
			const state = await this.db.transaction(async manager => {
				await this.links.lockReplyAuthorization(input, manager, GRIDSPACE_NOTIFICATION_WRITE_SCOPE);
				return action === 'read-all' ? this.notifications.readAllNotification(link.localUserId) : this.notifications.readNotifications(link.localUserId, input.ids!);
			});
			return this.page([], [], link.localUserId, state.unreadCount, input);
		}
		const rows = await this.raw(link.localUserId, input);
		const valid = await this.packer.packMany(rows.filter(n => !input.excludeTypes?.includes(n.type)), link.localUserId) as unknown as Packed<'Notification'>[];
		if (valid.length === 0) {
			const state = await this.reads.state(link.localUserId, []);
			await this.authorize(input);
			return this.page(rows, [], link.localUserId, state.unreadCount, input);
		}
		const noteIds = [...rows.flatMap(n => 'noteId' in n ? [n.noteId] : []), ...valid.flatMap(n => n.type === 'renote' && n.note.renoteId ? [n.note.renoteId] : [])];
		const items: WireNotification[] = [];
		const users = this.moduleRef.get<UserEntityService>('UserEntityService');
		const host = new URL(this.config.url).host;
		const displayUser = (user: Packed<'UserLite'>) => ({ ...user, host: user.host ?? host });
		const recipient = displayUser(await users.pack(link.localUserId, { id: link.localUserId }));
		const canManageFollowRequest = valid.some(n => n.type === 'receiveFollowRequest') && await this.links.hasFollowRequestScope(input);
		const notifierIds = [...new Set(rows.flatMap(n => 'notifierId' in n ? [n.notifierId] : []))];
		const actors = new Map((notifierIds.length ? await this.search.userQuery({ id: link.localUserId })
			.andWhere('user.id IN (:...notifierIds)', { notifierIds }).getMany() : []).map(actor => [actor.id, actor]));
		for (const packed of valid) {
			const raw = rows.find(n => n.id === packed.id)!;
			const actor = 'notifierId' in raw ? actors.get(raw.notifierId) : null;
			if ('notifierId' in raw && !actor) continue;
			let reactionUrl: string | null = null;
			if (raw.type === 'reaction' && raw.reaction.startsWith(':')) {
				const name = raw.reaction.slice(1, -1);
				const emojis = this.moduleRef.get<CustomEmojiService>('CustomEmojiService');
				const local = (await emojis.localEmojisCache.fetch()).get(name.replace(/@\.$/, ''));
				reactionUrl = local?.publicUrl || local?.originalUrl || (await emojis.populateEmojis([name], null))[name] || null;
			}
			items.push({ id: raw.id, createdAt: new Date(raw.createdAt).toISOString(), type: raw.type, isRead: false, note: null,
				user: actor ? { name: actor.name, username: actor.username, host: actor.host ?? new URL(this.config.url).host, uri: actor.uri ?? `${this.config.url}/users/${actor.id}` } : null,
				body: raw.type === 'app' ? raw.customBody : raw.type === 'followRequestAccepted' ? raw.message : null,
				reaction: raw.type === 'reaction' ? canonicalReaction(raw.reaction, this.config.url) : null,
				presentation: {
					followRequestId: raw.type === 'receiveFollowRequest' && raw.followRequestId && await this.db.getRepository(MiFollowRequest).existsBy({ id: raw.followRequestId, followeeId: link.localUserId, followerId: raw.notifierId }) ? raw.followRequestId : null,
					canManageFollowRequest,
					user: 'user' in packed ? displayUser(packed.user) : null, recipient,
					noteUser: 'note' in packed ? displayUser(packed.note.user) : null,
					header: raw.type === 'app' ? raw.customHeader : null, icon: raw.type === 'app' ? raw.customIcon ?? null : null,
					achievement: raw.type === 'achievementEarned' ? raw.achievement : null,
					roleName: packed.type === 'roleAssigned' ? packed.role.name : null, roleIcon: packed.type === 'roleAssigned' ? packed.role.iconUrl : null,
					roomName: packed.type === 'chatRoomInvitationReceived' ? packed.invitation.room.name : null,
					exportedEntity: raw.type === 'exportCompleted' ? raw.exportedEntity : null, fileId: raw.type === 'exportCompleted' ? raw.fileId : null, reactionUrl,
				} });
		}
		// Pack protected bodies last, after notifier lookups. peerNotes rechecks
		// the note audience/deletion and grant after its own asynchronous work.
		const notes: NonNullable<WireNotification['note']>[] = [];
		const uniqueNoteIds = [...new Set(noteIds)];
		for (let i = 0; i < uniqueNoteIds.length; i += 100) {
			notes.push(...(await this.notes.peerNotes({ ...input, mode: 'validate', contextMode: 'show', ids: uniqueNoteIds.slice(i, i + 100) })).notes);
		}
		const visible = items.filter(item => {
			const raw = rows.find(n => n.id === item.id)!;
			if (!('noteId' in raw)) return true;
			item.note = notes.find(n => n.id === raw.noteId) ?? null;
			if (item.type === 'renote' && item.note?.renoteId) item.renote = notes.find(n => n.id === item.note!.renoteId) ?? null;
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
		// Request-scoped only: repeated reactions often share their notifier and
		// target author. Every subsequent request checks current blocks/mutes again.
		const actorChecks = new Map<string, Promise<boolean>>();
		const actorAllows = (actor: NonNullable<WireNotification['user']>) => {
			const key = JSON.stringify([actor.uri, actor.host]);
			let result = actorChecks.get(key);
			if (!result) { result = this.notes.localActorAllows(user, actor); actorChecks.set(key, result); }
			return result;
		};
		for (const item of page.items) {
			if (item.user && !await actorAllows(item.user)) continue;
			if (item.note && !await this.notes.localAllows(user, item.note, false, link.peerUserId, actorAllows)) continue;
			const note = item.note ? (({ filterActors: _, ...display }) => display)(item.note) : null;
			const renote = item.renote && await this.notes.localAllows(user, item.renote, false, link.peerUserId, actorAllows) ? (({ filterActors: _, ...display }) => display)(item.renote) : null;
			items.push({ ...item, note, renote });
		}
		await this.links.checkPrivateUnchanged(link);
		return { ...page, items };
	}

	public async decide(user: MiLocalUser, notificationId: string, followRequestId: string, accept: boolean) {
		const link = await this.links.privateLink(user.id);
		const result = await this.links.json<NotificationPage<WireNotification>>(`/gridspace/v1/notifications/${accept ? 'accept-follow' : 'reject-follow'}`, { ids: [notificationId], followRequestId, ...this.links.privateCredential(link) });
		if (result.origin !== link.peerOrigin || result.recipientId !== link.peerUserId) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		await this.links.checkPrivateUnchanged(link);
		return { done: true };
	}
}
