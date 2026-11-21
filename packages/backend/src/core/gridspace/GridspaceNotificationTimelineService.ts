/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceNotificationService } from './GridspaceNotificationService.js';
import type { LocalNotification, PeerNotification, NotificationPage } from './notification-protocol.js';

export const notificationSources = ['local', 'peer', 'channel'] as const;
export type NotificationSource = typeof notificationSources[number];
type Status = 'ok' | 'disabled' | 'unavailable' | 'unauthorized';
type Reference = { key: string; source: NotificationSource; origin: string; recipientId: string; id: string; createdAt: string };
type Snapshot = { userId: string; filter: string; secret: string; expiresAt: number; bindings: Record<NotificationSource, string | null>; sources: Record<NotificationSource, Status>; retryable?: Partial<Record<NotificationSource, boolean>>; refs: Reference[] };
export type NotificationTimelineInput = { cursor?: string; mode?: 'page' | 'refresh' | 'validate'; limit?: number; count?: number; excludeTypes?: string[] };
export type NotificationTimelineRow = Reference & { isRead: boolean; local: LocalNotification['notification'] | null; remote: PeerNotification | null };
export type NotificationTimelinePage = { version: number; cursor: string; nextCursor: string | null; scannedCount: number; items: NotificationTimelineRow[]; complete: boolean; sources: { source: NotificationSource; status: Status; retryable: boolean; unreadCount: number | null }[]; revalidateAfterMs: number };

const prefix = 'gridspace:notification-timeline:';
const ttl = 30 * 60;
// Snapshot creation and the per-user bound are one atomic operation. Values are
// immutable: competing/replayed page reads cannot consume or replace a boundary.
export const saveNotificationSnapshotScript = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3] - ARGV[2] * 1000)
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
local old = redis.call('ZRANGE', KEYS[2], 0, -9)
for _, key in ipairs(old) do redis.call('DEL', key); redis.call('ZREM', KEYS[2], key) end
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1`;

@Injectable()
export class GridspaceNotificationTimelineService {
	constructor(
		@Inject(DI.redis) private redis: Redis.Redis,
		private notifications: GridspaceNotificationService,
		private links: GridspaceLinkService,
	) {}

	private filter(input: NotificationTimelineInput) { return JSON.stringify([...new Set(input.excludeTypes ?? [])].sort()); }
	private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
	private async within<T>(promise: Promise<T>, deadline: number): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([promise, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new GridspaceLinkError('PEER_UNAVAILABLE', true)), Math.max(0, deadline - Date.now()));
			})]);
		} finally { clearTimeout(timer); }
	}
	private async binding(user: MiLocalUser, source: NotificationSource): Promise<string | null> {
		if (source === 'local') return user.id;
		if (source === 'channel') return this.notifications.guestBinding(user);
		try {
			const link = await this.links.privateLink(user.id);
			return link.privateTokenCipher ? this.hash([link.id, link.generation, link.privateRevision, link.privateTokenCipher, link.peerOrigin, link.peerUserId]) : null;
		} catch (error) {
			if (error instanceof GridspaceLinkError && ['DISABLED', 'LINK_REVOKED', 'AUTHORIZATION_REVOKED'].includes(error.code)) return null;
			throw error;
		}
	}
	private status(error: unknown): Status {
		return error instanceof GridspaceLinkError && ['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code) ? 'unauthorized' : 'unavailable';
	}
	private signature(snapshot: Snapshot, id: string, offset: number, limit: number) {
		return createHmac('sha256', snapshot.secret).update(JSON.stringify([id, snapshot.userId, snapshot.filter, offset, limit])).digest('hex');
	}
	private cursor(snapshot: Snapshot, id: string, offset: number, limit: number) { return `${id}.${offset}.${limit}.${this.signature(snapshot, id, offset, limit)}`; }

	private async mayRetry(user: MiLocalUser, source: NotificationSource, binding: string | null, error: unknown) {
		if (!binding || !(error instanceof GridspaceLinkError) || !error.retryable) return false;
		try { return await this.within(this.binding(user, source), Date.now() + 250) === binding; } catch { return false; }
	}
	private async create(user: MiLocalUser, input: NotificationTimelineInput, deadline: number, previous?: Snapshot) {
		const snapshot: Snapshot = { userId: user.id, filter: this.filter(input), secret: randomBytes(32).toString('hex'), expiresAt: Date.now() + ttl * 1000,
																															bindings: { local: null, peer: null, channel: null }, sources: { local: 'ok', peer: 'disabled', channel: 'disabled' }, retryable: {}, refs: [] };
		await Promise.all(notificationSources.map(async source => {
			try {
				const binding = await this.within(this.binding(user, source), deadline);
				if (!binding) return;
				const page = await this.within(source === 'local' ? this.notifications.localReferences(user, input) : this.notifications.remoteReferences(user, input, source === 'channel'), deadline);
				if (!page.complete) throw new GridspaceLinkError('SNAPSHOT_TOO_LARGE');
				if (await this.within(this.binding(user, source), deadline) !== binding) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				snapshot.bindings[source] = binding;
				snapshot.sources[source] = 'ok';
				snapshot.refs.push(...page.items.map(item => ({ id: item.id, createdAt: item.createdAt, source, origin: page.origin, recipientId: page.recipientId, key: JSON.stringify([page.origin, page.recipientId, item.id]) })));
			} catch (error) {
				snapshot.sources[source] = this.status(error);
				const oldBinding = previous?.bindings[source] ?? null;
				if (await this.mayRetry(user, source, oldBinding, error)) {
					snapshot.bindings[source] = oldBinding;
					snapshot.retryable![source] = true;
					snapshot.refs.push(...previous!.refs.filter(ref => ref.source === source));
				}
			}
		}));
		// Source IDs are never compared with each other. Ties use the full identity.
		const unique = new Map<string, Reference>();
		for (const ref of snapshot.refs) {
			const key = JSON.stringify([ref.origin, ref.recipientId, ref.id]);
			const current = unique.get(key);
			if (!current || (snapshot.sources[current.source] !== 'ok' && snapshot.sources[ref.source] === 'ok')) unique.set(key, { ...ref, key });
		}
		snapshot.refs = [...unique.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
		const id = randomUUID();
		await this.redis.eval(saveNotificationSnapshotScript, 2, prefix + id, prefix + 'user:' + user.id, JSON.stringify(snapshot), ttl, Date.now());
		return { snapshot, id };
	}

	private async load(user: MiLocalUser, input: NotificationTimelineInput) {
		const parts = input.cursor?.match(/^([0-9a-f-]{36})\.(\d{1,5})\.(\d{1,2})\.([0-9a-f]{64})$/);
		if (!parts) throw new GridspaceLinkError('CURSOR_INVALID');
		const [, id, offsetText, limitText, mac] = parts;
		const raw = await this.redis.get(prefix + id);
		if (!raw) throw new GridspaceLinkError('CURSOR_EXPIRED');
		const snapshot = JSON.parse(raw) as Snapshot;
		const offset = Number(offsetText); const limit = Number(limitText);
		if (snapshot.expiresAt <= Date.now()) throw new GridspaceLinkError('CURSOR_EXPIRED');
		if (snapshot.userId !== user.id || snapshot.filter !== this.filter(input) || offset > snapshot.refs.length || limit < 1 || limit > 40 ||
			!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.signature(snapshot, id, offset, limit), 'hex'))) throw new GridspaceLinkError('CURSOR_INVALID');
		return { snapshot, id, offset, limit };
	}

	public async read(user: MiLocalUser, input: NotificationTimelineInput): Promise<NotificationTimelinePage> {
		const startedAt = Date.now(); const deadline = startedAt + 8000;
		const mode = input.mode ?? 'page';
		let anchor: string | undefined;
		let previous: Snapshot | undefined;
		if (mode === 'refresh' && input.cursor) {
			try { previous = (await this.load(user, input)).snapshot; anchor = previous.refs[(input.count ?? 20) - 1]?.key; } catch (error) {
				if (!(error instanceof GridspaceLinkError) || error.code !== 'CURSOR_EXPIRED') throw error;
			}
		}
		const loaded = mode === 'refresh' || !input.cursor ? { ...await this.create(user, input, deadline, previous), offset: 0, limit: input.limit ?? 20 } : await this.load(user, input);
		const { snapshot, id, offset, limit } = loaded;
		const start = mode === 'validate' ? 0 : offset;
		const end = Math.min(snapshot.refs.length, mode !== 'page' ? Math.max(input.count ?? limit, anchor ? snapshot.refs.findIndex(ref => ref.key === anchor) + 1 : 0) : start + limit);
		const refs = snapshot.refs.slice(start, end);
		const statuses = { ...snapshot.sources };
		const retryable = { ...snapshot.retryable };
		const items = new Map<string, NotificationTimelineRow>();
		const counts: Record<NotificationSource, number | null> = { local: null, peer: null, channel: null };
		await Promise.all(notificationSources.map(async source => {
			if (!snapshot.bindings[source]) return;
			if (snapshot.sources[source] === 'unavailable') {
				retryable[source] = await this.mayRetry(user, source, snapshot.bindings[source], new GridspaceLinkError('PEER_UNAVAILABLE', retryable[source] === true));
				return;
			}
			try {
				if (await this.within(this.binding(user, source), deadline) !== snapshot.bindings[source]) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				const selected = refs.filter(ref => ref.source === source);
				let responseBytes = 0;
				for (let i = 0; i < Math.max(1, selected.length); i += 100) {
					const group = selected.slice(i, i + 100);
					const options = { excludeTypes: input.excludeTypes, ...(group.length ? { ids: group.map(ref => ref.id) } : { countOnly: true }) };
					const page = await this.within<NotificationPage<LocalNotification | PeerNotification>>(source === 'local' ? this.notifications.local(user, options) : this.notifications.remote(user, options, 'query', source === 'channel'), deadline);
					responseBytes += Buffer.byteLength(JSON.stringify(page));
					if (responseBytes > 640 * 1024) throw new GridspaceLinkError('PEER_UNAVAILABLE');
					counts[source] = page.unreadCount;
					for (const ref of group) {
						if (ref.origin !== page.origin || ref.recipientId !== page.recipientId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
						const item = page.items.find(item => item.id === ref.id);
						if (item) items.set(ref.key, { ...ref, isRead: item.isRead, local: source === 'local' ? (item as LocalNotification).notification : null, remote: source === 'local' ? null : item as PeerNotification });
					}
				}
				if (await this.within(this.binding(user, source), deadline) !== snapshot.bindings[source]) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				statuses[source] = 'ok';
			} catch (error) {
				statuses[source] = this.status(error); counts[source] = null;
				retryable[source] = await this.mayRetry(user, source, snapshot.bindings[source], error);
				for (const ref of refs.filter(ref => ref.source === source)) items.delete(ref.key);
			}
		}));
		return { version: 1, cursor: this.cursor(snapshot, id, 0, limit), nextCursor: end < snapshot.refs.length ? this.cursor(snapshot, id, end, limit) : null, scannedCount: end,
											items: refs.flatMap(ref => items.has(ref.key) ? [items.get(ref.key)!] : []), complete: notificationSources.every(source => statuses[source] === 'ok' || statuses[source] === 'disabled'),
			sources: notificationSources.map(source => ({ source, status: statuses[source], retryable: retryable[source] === true, unreadCount: counts[source] })), revalidateAfterMs: Math.max(0, 10000 - (Date.now() - startedAt)) };
	}
}
