/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, In, IsNull, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { NotificationService } from '@/core/NotificationService.js';
import { NotificationReadService } from '@/core/NotificationReadService.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { MiNotification } from '@/models/Notification.js';
import type { Packed } from '@/misc/json-schema.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { canonicalReaction } from './reaction-protocol.js';
import { GRIDSPACE_NOTIFICATION_WRITE_SCOPE } from './link-crypto.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspacePlacementService } from './GridspacePlacementService.js';
import { dedicatedOriginal } from './conversation-protocol.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { notificationReferenceLimit, type NotificationReferences, type GuestReference, type WireReferences } from './notification-protocol.js';
import type { NotificationOptions, NotificationPeerRequest, NotificationPage, WireNotification, LocalNotification, PeerNotification } from './notification-protocol.js';
import type { PrivateWireNote } from './private-protocol.js';

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
		private channels: GridspaceChannelAuthService,
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

	private async guestIdentity(user: MiLocalUser) {
		if (this.config.gridspace?.enabled) {
			const placements = this.moduleRef.get(GridspacePlacementService);
			if (await placements.hasPeerCapability()) {
				const { actorId } = await placements.currentActorCredential(user);
				const peerOrigin = new URL(this.config.gridspace.peerUrl).origin;
				return { credential: { placementActorId: actorId }, peerOrigin, key: `placement:${peerOrigin}:${actorId}`,
					check: async () => { await placements.currentActorCredential(user); } };
			}
		}
		return this.channels.destination(user, true);
	}

	public async guestBinding(user: MiLocalUser): Promise<string | null> {
		if (!this.config.gridspace?.enabled) return null;
		if (!this.channels.isClient && !await this.moduleRef.get(GridspacePlacementService).hasPeerCapability()) return null;
		return (await this.guestIdentity(user)).key;
	}

	private async authorize(input: NotificationPeerRequest, manager?: EntityManager) {
		if (input.channelActorId || input.placementActorId) {
			if ((input.channelActorId && input.placementActorId) || input.accessToken || input.linkId || input.localUserId || input.generation || input.pairId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			const actor = input.placementActorId ? await this.moduleRef.get(GridspacePlacementService).resolveActor(input.placementActorId, manager)
				: await this.channels.source(input.channelActorId!, manager);
			return { localUserId: actor.id };
		}
		const link = await this.links.authorizePrivate(input);
		if (!await this.links.hasNotificationScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return link;
	}

	private async channelRows(userId: string, input: NotificationPeerRequest = {}, fetched?: MiNotification[], origins = new Map<string, MiNote>()) {
		const rows = fetched ?? await this.raw(userId, { ...input, countOnly: false, limit: this.config.perUserNotificationsMaxCount });
		const ids = rows.flatMap(row => row.type === 'reaction' || (input.placementActorId && row.type === 'reply') ? [row.noteId] : []);
		if (!ids.length) return [];
		const notes = await this.search.read(this.search.noteQuery({ id: userId }, { query: '' }, false, true, undefined, false, true)
			.andWhere('note.id IN (:...notificationNotes) AND note.localOnly = true AND note.uri IS NULL', { notificationNotes: ids })
			.andWhere('(note.userId = :recipient OR note.replyUserId = :recipient)', { recipient: userId }));
		for (const note of notes) origins.set(note.id, note);
		const candidates = rows.filter(row => {
			if (row.type !== 'reaction' && row.type !== 'reply') return false;
			const note = origins.get(row.noteId);
			if (!note) return false;
			if (note.channelId && (!input.placementActorId || this.config.gridspace?.channelRole === 'source')) return row.type === 'reaction' && note.userId === userId;
			if (!input.placementActorId || !dedicatedOriginal(note) || note.multiNoteKind !== 'conversation-reply' || !['public', 'home'].includes(note.visibility)) return false;
			return row.type === 'reaction' ? note.userId === userId : note.replyUserId === userId && note.userId === row.notifierId;
		});
		if (!candidates.length) return [];
		const notifiers = await this.search.userQuery({ id: userId }).andWhere('user.id IN (:...notificationActors)', { notificationActors: candidates.flatMap(row => 'notifierId' in row ? [row.notifierId] : []) }).getMany();
		const allowed = new Set(notifiers.map(user => user.id));
		return candidates.filter(row => 'notifierId' in row && allowed.has(row.notifierId));
	}

	/** A signed wake-up carries neither a notification body nor an unread count. */
	public async receiveGuestHint(actorId: string) {
		const exists = await this.db.getRepository(MiUser).existsBy({ id: actorId, host: IsNull(), isDeleted: false, isSuspended: false, movedToUri: IsNull() });
		if (exists) this.moduleRef.get(GlobalEventService).publishMainStream(actorId, 'gridspaceNotificationsChanged');
		return { ok: true };
	}

	public async hintGuest(userId: string, notification: MiNotification) {
		const peer = this.config.gridspace;
		if (!peer?.enabled) return;
		const origin = new URL(peer.peerUrl).origin;
		const actor = await this.db.getRepository(MiUser).findOneBy({ id: userId, host: new URL(origin).host, isSuspended: false, isDeleted: false, movedToUri: IsNull() });
		const prefix = origin + '/users/';
		if (!actor?.uri?.startsWith(prefix)) return;
		const actorId = actor.uri.slice(prefix.length);
		if (!/^[a-zA-Z0-9]{1,32}$/.test(actorId)) return;
		if (!(await this.channelRows(userId, { placementActorId: actorId }, [notification])).length) return;
		await this.sendGuestHint(actorId);
	}

	private async sendGuestHint(actorId: string) {
		await this.links.json('/gridspace/v1/notifications/changed', { expectedRecipientId: actorId });
	}

	private async channelCount(userId: string, input: NotificationPeerRequest) {
		const rows = await this.channelRows(userId, { placementActorId: input.placementActorId, channelActorId: input.channelActorId });
		const state = await this.reads.state(userId, rows.map(row => row.id));
		return state.isRead.filter(read => !read).length;
	}

	/** References only: no protected body or author is cached by the coordinator. */
	public async localReferences(user: MiLocalUser, input: NotificationOptions): Promise<NotificationReferences> {
		const rows = await this.raw(user.id, { limit: notificationReferenceLimit + 1 });
		return this.references(rows, user.id, input);
	}

	private references(rows: MiNotification[], userId: string, input: NotificationOptions): NotificationReferences {
		return { origin: this.config.url, recipientId: userId, complete: rows.length <= notificationReferenceLimit,
											items: rows.slice(0, notificationReferenceLimit).filter(row => !input.excludeTypes?.includes(row.type)).map(row => ({ id: row.id, createdAt: new Date(row.createdAt).toISOString() })) };
	}

	public async peerReferences(input: NotificationPeerRequest): Promise<WireReferences> {
		const link = await this.authorize(input);
		const fetched = await this.raw(link.localUserId, { limit: notificationReferenceLimit + 1 });
		const origins = new Map<string, MiNote>();
		const rows = input.channelActorId || input.placementActorId ? await this.channelRows(link.localUserId, input, fetched, origins) : fetched;
		const refs = this.references(rows, link.localUserId, input);
		let items: WireReferences['items'] = refs.items;
		if (input.placementActorId && items.length) {
			// Supply actor identities only, so the home can apply its own block/mute rules to counts and reads.
			const related = new Map(rows.flatMap(row => {
				if (!('noteId' in row) || !('notifierId' in row)) return [];
				const note = origins.get(row.noteId)!;
				const ids = [row.notifierId, note.userId, note.replyUserId, note.renoteUserId, note.renote?.replyUserId, note.renote?.renoteUserId];
				return [[row.id, [...new Set(ids.filter((id): id is string => !!id))]] as const];
			}));
			const users = await this.db.getRepository(MiUser).findBy({ id: In([...new Set([...related.values()].flat())]) });
			const actors = new Map(users.map(user => [user.id, { uri: user.uri ?? `${this.config.url}/users/${user.id}`,
				host: user.host ?? new URL(this.config.url).host, username: user.username, name: null }]));
			const state = await this.reads.state(link.localUserId, items.map(row => row.id));
			items = items.flatMap((ref, i) => {
				const ids = related.get(ref.id)!;
				return ids.every(id => actors.has(id)) ? [{ ...ref, isRead: state.isRead[i], actors: ids.map(id => actors.get(id)!) }] : [];
			});
		}
		await this.authorize(input);
		return { ...refs, items, complete: fetched.length <= notificationReferenceLimit };
	}

	public async remoteReferences(user: MiLocalUser, input: NotificationOptions, channel = false): Promise<NotificationReferences & { unreadCount?: number }> {
		const identity = channel ? await this.guestIdentity(user) : null;
		const link = identity ? null : await this.links.privateLink(user.id);
		const page = await this.links.json<WireReferences>('/gridspace/v1/notifications/references', {
			excludeTypes: input.excludeTypes, ...(identity ? identity.credential : this.links.privateCredential(link!)),
		});
		if (page.origin !== (identity?.peerOrigin ?? link!.peerOrigin) || (!identity && page.recipientId !== link!.peerUserId) ||
			!Array.isArray(page.items) || page.items.length > notificationReferenceLimit || typeof page.complete !== 'boolean' || !/^[a-zA-Z0-9]{1,32}$/.test(page.recipientId) ||
			page.items.some(item => !/^[a-zA-Z0-9]{1,32}$/.test(item.id) || !Number.isFinite(Date.parse(item.createdAt)))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		let unreadCount: number | undefined;
		let items = page.items;
		if (identity && 'placementActorId' in identity.credential) {
			const eligible: GuestReference[] = [];
			for (const item of page.items) {
				if (!('actors' in item) || typeof item.isRead !== 'boolean' || !Array.isArray(item.actors) || !item.actors.length || item.actors.length > 6 ||
					item.actors.some(actor => !actor.uri || !actor.host)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
				eligible.push(item);
			}
			const allows = await this.notes.localActorChecker(user, eligible.flatMap(row => row.actors));
			const visible = [];
			for (const item of eligible) if ((await Promise.all(item.actors.map(allows))).every(Boolean)) visible.push(item);
			unreadCount = visible.filter(item => !item.isRead).length;
			items = visible.map(({ id, createdAt }) => ({ id, createdAt }));
		}
		if (identity) await identity.check(); else await this.links.checkPrivateUnchanged(link!);
		return { ...page, items, unreadCount };
	}

	public async peer(action: string, input: NotificationPeerRequest): Promise<NotificationPage<WireNotification>> {
		const link = await this.authorize(input);
		if (input.expectedRecipientId && input.expectedRecipientId !== link.localUserId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const guest = !!(input.channelActorId || input.placementActorId);
		if (guest && !['query', 'read', 'read-all'].includes(action)) throw new GridspaceLinkError('ACTION_REJECTED');
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
				if (guest) await this.authorize(input, manager);
				else await this.links.lockReplyAuthorization(input, manager, GRIDSPACE_NOTIFICATION_WRITE_SCOPE);
				if (guest) {
					const eligible = await this.channelRows(link.localUserId, { placementActorId: input.placementActorId, channelActorId: input.channelActorId, ids: action === 'read' ? input.ids : undefined });
					const changed = await this.notifications.readNotifications(link.localUserId, eligible.map(row => row.id));
					return { changed: changed.changed, unreadCount: await this.channelCount(link.localUserId, input) };
				}
				return action === 'read-all' ? this.notifications.readAllNotification(link.localUserId) : this.notifications.readNotifications(link.localUserId, input.ids!);
			});
			if (input.placementActorId && state.changed) void this.sendGuestHint(input.placementActorId).catch(() => {});
			return this.page([], [], link.localUserId, state.unreadCount, input);
		}
		const channelCount = guest ? await this.channelCount(link.localUserId, input) : null;
		if (guest && input.countOnly) {
			await this.authorize(input);
			return this.page([], [], link.localUserId, channelCount!, input);
		}
		const origins = new Map<string, MiNote>();
		const rows = guest ? (await this.channelRows(link.localUserId, input, undefined, origins)).slice(0, input.ids?.length ?? input.limit ?? 20) : await this.raw(link.localUserId, input);
		const valid = await this.packer.packMany(rows.filter(n => !input.excludeTypes?.includes(n.type)), link.localUserId) as unknown as Packed<'Notification'>[];
		if (valid.length === 0) {
			const state = await this.reads.state(link.localUserId, []);
			await this.authorize(input);
			return this.page(rows, [], link.localUserId, channelCount ?? state.unreadCount, input);
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
		if (guest) {
			const groups = new Map<string, string[]>();
			for (const id of uniqueNoteIds) {
				const note = origins.get(id);
				if (input.placementActorId && note?.multiNoteKind === 'conversation-reply' && !note.channelId) {
					const conversationUri = `${this.config.url}/notes/${id}`;
					try {
						const page = await this.notes.peerNotes({ mode: 'show', placementActorId: input.placementActorId, conversationUri, noteId: id });
						notes.push(...page.notes.filter(wire => wire.id === id));
					} catch (error) {
						if (!(error instanceof GridspaceLinkError) || error.code !== 'ACTION_REJECTED') throw error;
					}
					continue;
				}
				if (note?.channelId) groups.set(note.channelId, [...(groups.get(note.channelId) ?? []), id]);
			}
			for (const [channelId, ids] of groups) notes.push(...(await this.notes.peerNotes({ channelActorId: input.channelActorId ?? input.placementActorId, mode: 'validate', contextMode: 'show', channelId, ids })).notes);
		} else for (let i = 0; i < uniqueNoteIds.length; i += 100) {
			notes.push(...(await this.notes.peerNotes({ ...input, mode: 'validate', contextMode: 'show', ids: uniqueNoteIds.slice(i, i + 100) })).notes);
		}
		const visible = items.filter(item => {
			const raw = rows.find(n => n.id === item.id)!;
			if (!('noteId' in raw)) return true;
			item.note = notes.find(n => n.id === raw.noteId) ?? null;
			if (input.placementActorId && item.note?.conversationUri) item.recipientActorUri = `${new URL(this.config.gridspace!.peerUrl).origin}/users/${input.placementActorId}`;
			if (item.type === 'renote' && item.note?.renoteId) item.renote = notes.find(n => n.id === item.note!.renoteId) ?? null;
			return item.note != null;
		});
		await this.authorize(input);
		const state = await this.reads.state(link.localUserId, visible.map(n => n.id));
		visible.forEach((n, i) => { n.isRead = state.isRead[i]; });
		return this.page(rows, visible, link.localUserId, channelCount ?? state.unreadCount, input);
	}

	public async remote(user: MiLocalUser, input: NotificationOptions, action = 'query', channel = false): Promise<NotificationPage<PeerNotification>> {
		const identity = channel ? await this.guestIdentity(user) : null;
		const link = identity ? null : await this.links.privateLink(user.id);
		// Endpoint inputs can contain login credentials and unknown properties.
		// Only the documented query fields may cross the server boundary.
		if (input.expectedOrigin && input.expectedOrigin !== (identity?.peerOrigin ?? link!.peerOrigin)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (!identity && input.expectedRecipientId && input.expectedRecipientId !== link!.peerUserId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const options: NotificationOptions = { before: input.before, since: input.since, ids: input.ids, excludeTypes: input.excludeTypes, limit: input.limit, countOnly: input.countOnly, expectedRecipientId: input.expectedRecipientId };
		const placement = identity && 'placementActorId' in identity.credential;
		const guestSummary = async () => {
			const refs = await this.remoteReferences(user, {}, true);
			if (refs.unreadCount == null || !refs.complete) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			if (refs.origin !== identity!.peerOrigin || (input.expectedRecipientId && input.expectedRecipientId !== refs.recipientId)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return { ...refs, unreadCount: refs.unreadCount };
		};
		const summary = placement ? await guestSummary() : null;
		if (summary && (input.countOnly || action === 'read' || action === 'read-all')) {
			let fresh = summary;
			if (action !== 'query') {
				const selected = summary.items.filter(item => action === 'read-all' || input.ids?.includes(item.id)).map(item => item.id);
				for (let i = 0; i < selected.length; i += 100) {
					await this.links.json('/gridspace/v1/notifications/read', { ...identity!.credential, expectedRecipientId: summary.recipientId, ids: selected.slice(i, i + 100) });
				}
				if (selected.length) fresh = await guestSummary();
				if (fresh.recipientId !== summary.recipientId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			}
			return { items: [], next: null, newest: null, boundary: null, origin: fresh.origin, recipientId: fresh.recipientId, unreadCount: fresh.unreadCount };
		}
		const pageSize = input.limit ?? 20;
		let selected = summary?.items;
		if (selected && summary) {
			const eligible = new Map(selected.map(ref => [ref.id, ref]));
			selected = input.ids ? input.ids.flatMap(id => eligible.has(id) ? [eligible.get(id)!] : []) :
				selected.filter(ref => (!input.before || ref.id < input.before) && (!input.since || ref.id > input.since));
			if (!input.ids && input.since && !input.before) selected.reverse();
			if (!input.ids) selected = selected.slice(0, pageSize);
			if (!selected.length) return { origin: summary.origin, recipientId: summary.recipientId, items: [], next: null, newest: null, boundary: null, unreadCount: summary.unreadCount };
			options.ids = selected.map(ref => ref.id);
			options.expectedRecipientId = summary.recipientId;
		}
		const page = await this.links.json<NotificationPage<WireNotification>>(`/gridspace/v1/notifications/${action}`, { ...options, ...(identity ? identity.credential : this.links.privateCredential(link!)) });
		if (page.origin !== (identity?.peerOrigin ?? link!.peerOrigin) || (!identity && page.recipientId !== link!.peerUserId) || !Array.isArray(page.items) || page.items.length > 100) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		if (summary && page.recipientId !== summary.recipientId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (identity) {
			const actorUri = `${this.config.url}/users/${user.id}`;
			const valid = page.items.every(item => {
				const note = item.note;
				if (!note) return false;
				if (note.channelId) return item.type === 'reaction' && note.author.uri === actorUri;
				if (!('placementActorId' in identity.credential) || item.recipientActorUri !== actorUri || note.multiNoteKind !== 'conversation-reply' || note.includeDefault !== false || !note.localOnly ||
					note.conversationUri !== `${identity.peerOrigin}/notes/${note.id}` || note.uri !== note.conversationUri) return false;
				return item.type === 'reaction' ? note.author.uri === actorUri : item.type === 'reply' && item.user?.uri === note.author.uri && note.filterActors.some(actor => actor.uri === actorUri);
			});
			if (!valid) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		}
		const items: PeerNotification[] = [];
		const actorAllows = await this.notes.localActorChecker(user, [
			...page.items.flatMap(item => item.user ? [item.user] : []),
			...this.notes.actorsForNotes(page.items.flatMap(item => [item.note, item.renote].filter((note): note is PrivateWireNote => note != null))),
		]);
		for (const item of page.items) {
			if (item.user && !await actorAllows(item.user)) continue;
			const peerUserId = identity ? page.recipientId : link!.peerUserId;
			if (item.note && !await this.notes.localAllows(user, item.note, false, peerUserId, actorAllows)) continue;
			const note = item.note ? await this.notes.filterChannelRenote(user, (({ filterActors: _, ...display }) => display)(item.note), peerUserId, actorAllows) : null;
			const renote = item.renote && await this.notes.localAllows(user, item.renote, false, peerUserId, actorAllows) ? await this.notes.filterChannelRenote(user, (({ filterActors: _, ...display }) => display)(item.renote), peerUserId, actorAllows) : null;
			const { recipientActorUri: _recipient, ...display } = item;
			items.push({ ...display, note, renote });
		}
		if (identity) await identity.check(); else await this.links.checkPrivateUnchanged(link!);
		if (selected && summary) {
			return { ...page, items, next: !input.ids && selected.length === pageSize ? selected.at(-1)!.id : null,
				newest: (input.since ? selected.at(-1) : selected[0])?.id ?? null, boundary: selected.at(-1)?.createdAt ?? null, unreadCount: summary.unreadCount };
		}
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
