/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiAccessToken } from '@/models/AccessToken.js';
import { MiFollowing } from '@/models/Following.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { MiMuting } from '@/models/Muting.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiGridspaceAuthSession, MiGridspaceFollowOverride, MiGridspaceImportItem, MiGridspaceLink, type GridspaceSnapshotItem } from '@/models/Gridspace.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { createGridspaceHeaders, resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { GRIDSPACE_CALLBACK_PATH, GRIDSPACE_CLIENT_PATH, GRIDSPACE_LINK_SCOPES, gridspaceChallenge, gridspaceHash, openGridspaceSecret, sealGridspaceSecret } from './link-crypto.js';

export class GridspaceLinkError extends Error {
	constructor(public code: string) { super(code); }
}

export type GridspacePeerLinkRequest = { accessToken?: string; linkId?: string; generation?: number; localUserId?: string; localUsername?: string };

@Injectable()
export class GridspaceLinkService implements OnModuleInit, OnApplicationShutdown {
	private peer: GridspacePeerConfig | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;
	private workCursor: string | null = null;

	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.db) private db: DataSource,
		private following: UserFollowingService,
		private people: ApPersonService,
		private guard: GridspaceFollowGuardService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	public onModuleInit(): void {
		if (!this.peer) return;
		this.timer = setInterval(() => { void this.work(); }, 3000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	private enabled(): GridspacePeerConfig {
		if (!this.peer) throw new GridspaceLinkError('DISABLED');
		return this.peer;
	}

	private async json<T>(path: string, body: object, signed = true): Promise<T> {
		const peer = this.enabled();
		const bytes = Buffer.from(JSON.stringify(body));
		try {
			const response = await fetch(new URL(path, peer.peerOrigin), {
				method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(10000),
				headers: signed ? createGridspaceHeaders(peer, 'POST', path, bytes) : { 'content-type': 'application/json' },
			});
			// Bound streaming bodies as well as Content-Length, without logging credentials.
			const reader = response.body?.getReader();
			if (!reader) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const result = await reader.read();
					if (result.done) break;
					size += result.value.length;
					if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new GridspaceLinkError('PEER_UNAVAILABLE'); }
					chunks.push(result.value);
				}
			} finally { reader.releaseLock(); }
			const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (!response.ok) {
				const known = ['LINK_CONFLICT', 'LINK_REVOKED', 'AUTHORIZATION_REVOKED', 'SNAPSHOT_TOO_LARGE'];
				throw new GridspaceLinkError(known.includes(result.error) ? result.error : 'PEER_UNAVAILABLE');
			}
			return result as T;
		} catch (error) {
			if (error instanceof GridspaceLinkError) throw error;
			throw new GridspaceLinkError('PEER_UNAVAILABLE');
		}
	}

	public async start(user: MiLocalUser) {
		const peer = this.enabled();
		const state = randomBytes(32).toString('base64url');
		const clientKey = randomBytes(32).toString('base64url');
		const verifier = randomBytes(32).toString('base64url');
		const id = randomUUID();
		await this.db.getRepository(MiGridspaceAuthSession).delete({ localUserId: user.id, expiresAt: LessThan(new Date()) });
		await this.db.getRepository(MiGridspaceAuthSession).insert({
			id, localUserId: user.id, stateHash: gridspaceHash(state), clientHash: gridspaceHash(clientKey),
			verifierCipher: sealGridspaceSecret(peer, verifier, id), createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000),
		});
		const url = new URL('/oauth/authorize', peer.peerOrigin);
		url.search = new URLSearchParams({
			response_type: 'code', client_id: peer.origin + GRIDSPACE_CLIENT_PATH,
			redirect_uri: peer.origin + GRIDSPACE_CALLBACK_PATH, scope: GRIDSPACE_LINK_SCOPES.join(' '),
			state, code_challenge: gridspaceChallenge(verifier), code_challenge_method: 'S256'
		}).toString();
		return { authorizationUrl: url.href, clientKey };
	}

	public async finish(user: MiLocalUser, input: { state: string; clientKey: string; code: string; issuer: string }): Promise<void> {
		const peer = this.enabled();
		if (input.issuer !== peer.peerOrigin) throw new GridspaceLinkError('INVALID_CALLBACK');
		await this.guard.run(user.id, async () => {
			const sessions = this.db.getRepository(MiGridspaceAuthSession);
			const session = await sessions.findOneBy({ localUserId: user.id, stateHash: gridspaceHash(input.state), clientHash: gridspaceHash(input.clientKey) });
			if (!session || session.completed || session.expiresAt.getTime() < Date.now()) throw new GridspaceLinkError('INVALID_CALLBACK');
			if (!session.tokenCipher) {
				if (session.exchanged) throw new GridspaceLinkError('INVALID_CALLBACK');
				await sessions.update(session.id, { exchanged: true });
				const token = await this.json<{ access_token: string; token_type: string }>('/oauth/token', {
					grant_type: 'authorization_code', code: input.code, client_id: peer.origin + GRIDSPACE_CLIENT_PATH,
					redirect_uri: peer.origin + GRIDSPACE_CALLBACK_PATH, code_verifier: openGridspaceSecret(peer, session.verifierCipher, session.id),
				}, false);
				if (typeof token.access_token !== 'string' || token.token_type !== 'Bearer') throw new GridspaceLinkError('INVALID_CALLBACK');
				session.tokenCipher = sealGridspaceSecret(peer, token.access_token, session.id);
				await sessions.update(session.id, { tokenCipher: session.tokenCipher });
			}
			const accessToken = openGridspaceSecret(peer, session.tokenCipher, session.id);
			const identity = await this.json<{ id: string; username: string }>('/gridspace/v1/link/identity', { accessToken });
			const links = this.db.getRepository(MiGridspaceLink);
			let link = await links.findOneBy({ localUserId: user.id, peerOrigin: peer.peerOrigin, peerUserId: identity.id });
			if (link && !link.initiator) throw new GridspaceLinkError('LINK_CONFLICT');
			if (session.linkId && (session.linkId !== link?.id || session.generation !== link.generation)) throw new GridspaceLinkError('INVALID_CALLBACK');
			if (!session.linkId) {
				const occupied = await links.find({ where: [{ localUserId: user.id, state: In(['active', 'preparing']) }, { peerOrigin: peer.peerOrigin, peerUserId: identity.id, state: In(['active', 'preparing']) }] });
				if (occupied.some(other => other.id !== link?.id)) throw new GridspaceLinkError('LINK_CONFLICT');
				link = links.create({
					...link, id: link?.id ?? randomUUID(), localUserId: user.id, peerOrigin: peer.peerOrigin,
					peerUserId: identity.id, peerUsername: identity.username, generation: (link?.generation ?? 0) + 1,
					initiator: true, state: 'preparing', tokenCipher: null, createdAt: link?.createdAt ?? session.createdAt, lastError: null
				});
				try { await links.save(link); } catch { throw new GridspaceLinkError('LINK_CONFLICT'); }
				await sessions.update(session.id, { linkId: link.id, generation: link.generation });
			}
			if (!link || link.state === 'revoked') throw new GridspaceLinkError('LINK_REVOKED');
			const prepared = await this.json<{ id: string; generation: number; snapshot: GridspaceSnapshotItem[]; snapshotAt: string }>('/gridspace/v1/link/prepare', {
				accessToken, linkId: link.id, generation: link.generation, localUserId: user.id, localUsername: user.username,
			});
			if (prepared.id !== link.id || prepared.generation !== link.generation || !Array.isArray(prepared.snapshot) || prepared.snapshot.length > 10000) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			await this.db.transaction(async manager => {
				if (link.snapshot === null || link.snapshot === undefined) {
					for (const item of prepared.snapshot) {
						if (typeof item.uri !== 'string' || item.uri.length > 512 || !/^https?:\/\//.test(item.uri)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
						await manager.getRepository(MiGridspaceImportItem).insert({
							id: randomUUID(), linkId: link.id, actorUri: item.uri,
							withReplies: item.withReplies === true, state: item.skip ? 'skipped' : 'pending', reason: item.skip
						});
					}
				}
				await manager.getRepository(MiGridspaceLink).update(link.id, {
					state: 'active', snapshot: prepared.snapshot,
					snapshotAt: new Date(prepared.snapshotAt), tokenCipher: sealGridspaceSecret(peer, accessToken, link.id), lastError: null
				});
				await manager.getRepository(MiGridspaceAuthSession).update(session.id, { completed: true, tokenCipher: null, verifierCipher: '' });
			});
		});
		void this.work();
	}

	private async authorized(token: string | undefined): Promise<MiLocalUser> {
		const peer = this.enabled();
		if (!token) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const grant = await this.db.getRepository(MiAccessToken).findOneBy({ token, name: peer.peerOrigin + GRIDSPACE_CLIENT_PATH });
		if (!grant || !GRIDSPACE_LINK_SCOPES.every(scope => grant.permission.includes(scope))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = await this.db.getRepository(MiUser).findOneBy({ id: grant.userId, host: IsNull() });
		if (!user || user.isSuspended || user.isDeleted) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return user as MiLocalUser;
	}

	public async peerAction(action: string, input: GridspacePeerLinkRequest): Promise<object> {
		const peer = this.enabled();
		if (action === 'revoke') {
			const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: input.linkId, peerOrigin: peer.peerOrigin, peerUserId: input.localUserId, generation: input.generation });
			if (link) await this.revokeLocal(link);
			return { ok: true };
		}
		const user = await this.authorized(input.accessToken);
		if (action === 'identity') return { id: user.id, username: user.username };
		if (action === 'check') {
			const exists = await this.db.getRepository(MiGridspaceLink).existsBy({ id: input.linkId, localUserId: user.id, peerUserId: input.localUserId, peerOrigin: peer.peerOrigin, generation: input.generation, state: 'active' });
			if (!exists) throw new GridspaceLinkError('LINK_REVOKED');
			return { ok: true };
		}
		if (action !== 'prepare' || !input.linkId || !input.localUserId || !input.localUsername || !input.generation) throw new GridspaceLinkError('INVALID_CALLBACK');
		return this.guard.run(user.id, () => this.db.transaction('REPEATABLE READ', async manager => {
			await this.authorized(input.accessToken);
			const links = manager.getRepository(MiGridspaceLink);
			let link = await links.findOneBy({ id: input.linkId });
			if (link && (link.localUserId !== user.id || link.peerOrigin !== peer.peerOrigin || link.peerUserId !== input.localUserId || link.initiator)) throw new GridspaceLinkError('LINK_CONFLICT');
			if (link && (input.generation! < link.generation || (link.state === 'revoked' && input.generation === link.generation))) throw new GridspaceLinkError('LINK_REVOKED');
			link = links.create({
					...link, id: input.linkId, localUserId: user.id, peerOrigin: peer.peerOrigin, peerUserId: input.localUserId,
					peerUsername: input.localUsername, generation: input.generation, initiator: false, state: 'active', createdAt: link?.createdAt ?? new Date()
				});
			if (link.snapshot === null || link.snapshot === undefined) {
				const followed = await manager.getRepository(MiFollowing).find({ where: { followerId: user.id }, relations: { followee: true }, take: 10001 });
				if (followed.length > 10000) throw new GridspaceLinkError('SNAPSHOT_TOO_LARGE');
				const muted = await manager.getRepository(MiMuting).findBy({ muterId: user.id });
				const blocks = await manager.getRepository(MiBlocking).find({ where: [{ blockerId: user.id }, { blockeeId: user.id }] });
				const excluded = new Set([...muted.filter(mute => !mute.expiresAt || mute.expiresAt.getTime() > Date.now()).map(mute => mute.muteeId), ...blocks.map(block => block.blockerId === user.id ? block.blockeeId : block.blockerId)]);
				link.snapshot = followed.filter(follow => follow.followee).map(follow => ({
					uri: follow.followee!.uri ?? `${peer.origin}/users/${follow.followeeId}`, withReplies: follow.withReplies,
					skip: excluded.has(follow.followeeId) ? 'SOURCE_RESTRICTED' : follow.followee!.isSuspended || follow.followee!.isDeleted ? 'UNAVAILABLE' : null,
				}));
				link.snapshotAt = new Date();
			}
			try { await links.save(link); } catch { throw new GridspaceLinkError('LINK_CONFLICT'); }
			return { id: link.id, generation: link.generation, snapshot: link.snapshot, snapshotAt: link.snapshotAt!.toISOString() };
		}));
	}

	private async revokeLocal(link: MiGridspaceLink): Promise<void> {
		await this.guard.run(link.localUserId, async () => {
			const current = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: link.id, generation: link.generation });
			if (current) await this.commitRevocation(current);
		});
	}

	private async commitRevocation(link: MiGridspaceLink): Promise<void> {
		await this.db.transaction(async manager => {
			await manager.getRepository(MiGridspaceAuthSession).delete({ localUserId: link.localUserId });
			await manager.getRepository(MiAccessToken).delete({ userId: link.localUserId, name: link.peerOrigin + GRIDSPACE_CLIENT_PATH });
			await manager.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation }, { state: 'revoked', tokenCipher: null });
			await manager.getRepository(MiGridspaceImportItem).update({ linkId: link.id, state: In(['pending', 'failed']) }, { state: 'cancelled', reason: 'LINK_REVOKED' });
		});
	}

	public async revoke(user: MiLocalUser): Promise<void> {
		this.enabled();
		const link = await this.guard.run(user.id, async () => {
			await this.db.getRepository(MiGridspaceAuthSession).delete({ localUserId: user.id });
			const current = await this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId: user.id, state: In(['active', 'preparing']) });
			if (current) await this.commitRevocation(current);
			return current;
		});
		if (!link) return;
		try { await this.json('/gridspace/v1/link/revoke', { linkId: link.id, localUserId: user.id, generation: link.generation }); } catch { await this.db.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, state: 'revoked' }, { lastError: 'REVOKE_PENDING' }); }
	}

	public async retry(user: MiLocalUser): Promise<void> {
		this.enabled();
		await this.guard.run(user.id, async () => {
			const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId: user.id, state: 'active', initiator: true });
			if (!link) throw new GridspaceLinkError('LINK_REVOKED');
			await this.db.getRepository(MiGridspaceImportItem).update({ linkId: link.id, state: 'failed' }, { state: 'pending', reason: null });
		});
		void this.work();
	}

	public async status(user: MiLocalUser) {
		const links = this.db.getRepository(MiGridspaceLink);
		const link = this.peer ? await links.findOneBy({ localUserId: user.id, peerOrigin: this.peer.peerOrigin, state: In(['active', 'preparing']) }) ?? await links.findOne({ where: { localUserId: user.id, peerOrigin: this.peer.peerOrigin }, order: { createdAt: 'DESC' } }) : null;
		const items = link ? await this.db.getRepository(MiGridspaceImportItem).find({ where: { linkId: link.id }, order: { actorUri: 'ASC' } }) : [];
		const following = new Set((await this.db.getRepository(MiFollowing).find({ where: { followerId: user.id }, select: { followeeId: true } })).map(follow => follow.followeeId));
		const requested = new Set((await this.db.getRepository(MiFollowRequest).find({ where: { followerId: user.id }, select: { followeeId: true } })).map(request => request.followeeId));
		const packed = items.map(item => ({
			uri: item.actorUri, userId: item.targetUserId,
			state: item.state === 'requested' && item.targetUserId ? following.has(item.targetUserId) ? 'done' : requested.has(item.targetUserId) ? 'requested' : 'cancelled' : item.state, reason: item.reason
		}));
		return {
			enabled: !!this.peer, peerOrigin: this.peer?.peerOrigin ?? null, state: link?.state ?? 'unlinked', peerUsername: link?.peerUsername ?? null,
			peerUserId: link?.peerUserId ?? null, initiator: link?.initiator ?? false, lastError: link?.lastError ?? null,
			total: items.length, pending: packed.filter(item => item.state === 'pending').length, done: packed.filter(item => item.state === 'done').length,
			requested: packed.filter(item => item.state === 'requested').length, failed: packed.filter(item => item.state === 'failed').length,
			skipped: packed.filter(item => item.state === 'skipped' || item.state === 'cancelled').length, items: packed.slice(0, 100),
			authorizationUrl: null as string | null, clientKey: null as string | null
		};
	}

	private async work(): Promise<void> {
		if (this.working || !this.peer) return;
		this.working = true;
		try {
			await this.db.getRepository(MiGridspaceAuthSession).delete({ expiresAt: LessThan(new Date()) });
			const query = this.db.getRepository(MiGridspaceLink).createQueryBuilder('link')
				.where('((link.state = \'active\' AND link.initiator = TRUE AND EXISTS (SELECT 1 FROM gridspace_import_item item WHERE item."linkId" = link.id AND item.state = \'pending\')) OR (link.state = \'revoked\' AND link."lastError" = \'REVOKE_PENDING\'))')
				.orderBy('link.id', 'ASC').take(20);
			if (this.workCursor) query.andWhere('link.id > :cursor', { cursor: this.workCursor });
			const links = await query.getMany();
			this.workCursor = links.at(-1)?.id ?? null;
			for (const link of links) {
				if (link.state === 'revoked') {
					try { await this.json('/gridspace/v1/link/revoke', { linkId: link.id, localUserId: link.localUserId, generation: link.generation }); await this.db.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, state: 'revoked' }, { lastError: null }); } catch { /* Retry on the next pass. */ }
					continue;
				}
				const items = await this.db.getRepository(MiGridspaceImportItem).find({ where: { linkId: link.id, state: 'pending' }, take: 5 });
				if (items.length === 0 || !link.tokenCipher) continue;
				try {
					await this.json('/gridspace/v1/link/check', { linkId: link.id, localUserId: link.localUserId, generation: link.generation, accessToken: openGridspaceSecret(this.peer, link.tokenCipher, link.id) });
					for (const item of items) await this.importItem(link, item);
					await this.db.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, state: 'active' }, { lastError: null });
				} catch (error) {
					await this.db.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, state: 'active' }, { lastError: error instanceof GridspaceLinkError ? error.code : 'PEER_UNAVAILABLE' });
				}
			}
		} catch { /* Startup/shutdown or a database outage: durable pending items remain. */ } finally { this.working = false; }
	}

	private async importItem(link: MiGridspaceLink, item: MiGridspaceImportItem): Promise<void> {
		await this.guard.run(link.localUserId, async () => {
			const items = this.db.getRepository(MiGridspaceImportItem);
			if (!(await this.db.getRepository(MiGridspaceLink).existsBy({ id: link.id, state: 'active', generation: link.generation })) || !(await items.existsBy({ id: item.id, state: 'pending' }))) return;
			try {
				const user = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, host: IsNull() });
				if (!user || user.isSuspended || user.isDeleted) throw new GridspaceLinkError('UNAVAILABLE');
				const local = item.actorUri.startsWith(`${this.config.url}/users/`) ? await this.db.getRepository(MiUser).findOneBy({ id: item.actorUri.slice(`${this.config.url}/users/`.length), host: IsNull() }) : null;
				const target = local ?? await this.people.resolvePerson(item.actorUri);
				await items.update(item.id, { targetUserId: target.id });
				const override = await this.db.getRepository(MiGridspaceFollowOverride).findOneBy({ localUserId: user.id, targetUserId: target.id });
				if (override && override.changedAt >= link.createdAt) { await items.update(item.id, { state: 'cancelled', reason: 'USER_UNFOLLOWED' }); return; }
				const muted = await this.db.getRepository(MiMuting).findOneBy({ muterId: user.id, muteeId: target.id });
				const blocked = await this.db.getRepository(MiBlocking).exists({ where: [{ blockerId: user.id, blockeeId: target.id }, { blockerId: target.id, blockeeId: user.id }] });
				if (target.id === user.id || target.isSuspended || target.isDeleted || blocked || (muted && (!muted.expiresAt || muted.expiresAt.getTime() > Date.now()))) {
					await items.update(item.id, { state: 'skipped', reason: 'TARGET_RESTRICTED' }); return;
				}
				const where = { followerId: user.id, followeeId: target.id };
				if (!(await this.db.getRepository(MiFollowing).existsBy(where)) && !(await this.db.getRepository(MiFollowRequest).existsBy(where))) await this.following.follow(user, target, { withReplies: item.withReplies });
				await items.update(item.id, { state: await this.db.getRepository(MiFollowing).existsBy(where) ? 'done' : 'requested', reason: null });
			} catch { await items.update(item.id, { state: 'failed', reason: 'FOLLOW_FAILED' }); }
		});
	}
}
