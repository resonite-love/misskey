/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan, Raw, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { GRIDSPACE_PALETTE_SCOPE, GRIDSPACE_PALETTE_REGISTRY_SCOPE, GRIDSPACE_PALETTE_REGISTRY_KEY, parseGridspacePalette, type GridspacePalette } from './palette-protocol.js';
import { MiAccessToken } from '@/models/AccessToken.js';
import { MiFollowing } from '@/models/Following.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { MiMuting } from '@/models/Muting.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiGridspaceAuthSession, MiGridspaceFollowOverride, MiGridspaceImportItem, MiGridspaceLink, type GridspaceSnapshotItem } from '@/models/Gridspace.js';
import { IdService } from '@/core/IdService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { gridspacePeerTransport } from './peer-client.js';
import { createGridspaceHeaders, resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { GRIDSPACE_CALLBACK_PATH, GRIDSPACE_CLIENT_PATH, GRIDSPACE_LINK_SCOPES, GRIDSPACE_ALL_SCOPES, GRIDSPACE_PRIVATE_SCOPES, GRIDSPACE_PRIVATE_CLIENT_PATH, GRIDSPACE_PRIVATE_SCOPE, GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE, GRIDSPACE_REPLY_SCOPE, GRIDSPACE_ACTION_SCOPE, GRIDSPACE_NOTIFICATION_SCOPE, GRIDSPACE_NOTIFICATION_WRITE_SCOPE, gridspaceChallenge, gridspaceHash, openGridspaceSecret, sealGridspaceSecret } from './link-crypto.js';

const isLinkPurpose = (purpose: MiGridspaceAuthSession['purpose']) => purpose === 'link' || purpose === 'link-all';

export class GridspaceLinkError extends Error {
	constructor(public code: string) { super(code); }
}

export type GridspacePeerLinkRequest = { accessToken?: string; linkId?: string; generation?: number; localUserId?: string; localUsername?: string; pairId?: string; expectedRevision?: number; reverseToken?: string };

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
		private ids: IdService,
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

	public async json<T>(path: string, body: object, signed = true, maxBytes = 4 * 1024 * 1024): Promise<T> {
		const peer = this.enabled();
		const bytes = Buffer.from(JSON.stringify(body));
		try {
			// Keep reciprocal authorization POSTs off native fetch's HTTP/2 connection.
			const transport = gridspacePeerTransport(peer, path);
			const response = await fetch(transport.url, {
				agent: transport.agent,
				method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(10000),
				size: maxBytes,
				headers: { ...(signed ? createGridspaceHeaders(peer, 'POST', path, bytes) : { 'content-type': 'application/json' }), host: transport.host },
			});
			// node-fetch bounds streaming bodies, not just Content-Length.
			const result = await response.json();
			if (!response.ok) {
				const known = ['LINK_CONFLICT', 'LINK_REVOKED', 'AUTHORIZATION_REVOKED', 'SNAPSHOT_TOO_LARGE', 'REPLY_UNAVAILABLE', 'REPLY_REJECTED', 'REPLY_CONFLICT', 'REPLY_DELETED', 'RATE_LIMITED', 'ACTION_REJECTED', 'FILE_REJECTED'];
				const code = (result as { error?: unknown } | null)?.error;
				throw new GridspaceLinkError(typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE');
			}
			return result as T;
		} catch (error) {
			if (error instanceof GridspaceLinkError) throw error;
			throw new GridspaceLinkError('PEER_UNAVAILABLE');
		}
	}

	public async start(user: MiLocalUser, purpose: MiGridspaceAuthSession['purpose'] = 'link-all') {
		return !isLinkPurpose(purpose) ? this.guard.run(user.id, () => this.startSession(user, purpose)) : this.startSession(user, purpose);
	}

	private async startSession(user: MiLocalUser, purpose: MiGridspaceAuthSession['purpose']) {
		const peer = this.enabled();
		const link = !isLinkPurpose(purpose) ? await this.privateLink(user.id) : null;
		if (link?.privateRevocationCipher) throw new GridspaceLinkError('REVOKE_PENDING');
		const state = randomBytes(32).toString('base64url');
		const clientKey = randomBytes(32).toString('base64url');
		const verifier = randomBytes(32).toString('base64url');
		const id = randomUUID();
		await this.db.getRepository(MiGridspaceAuthSession).delete({ localUserId: user.id, expiresAt: LessThan(new Date()) });
		await this.db.getRepository(MiGridspaceAuthSession).insert({
			id, purpose, linkId: link?.id ?? null, generation: link?.generation ?? null,
			localUserId: user.id, stateHash: gridspaceHash(state), clientHash: gridspaceHash(clientKey),
			verifierCipher: sealGridspaceSecret(peer, verifier, id), createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000),
		});
		const url = new URL('/oauth/authorize', peer.peerOrigin);
		url.search = new URLSearchParams({
			response_type: 'code', client_id: peer.origin + (!isLinkPurpose(purpose) ? GRIDSPACE_PRIVATE_CLIENT_PATH : GRIDSPACE_CLIENT_PATH),
			redirect_uri: peer.origin + GRIDSPACE_CALLBACK_PATH, scope: purpose === 'link-all' ? GRIDSPACE_ALL_SCOPES.join(' ') : purpose === 'private-all' ? `${GRIDSPACE_PRIVATE_SCOPE} ${GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE} ${GRIDSPACE_REPLY_SCOPE} ${GRIDSPACE_ACTION_SCOPE} ${GRIDSPACE_NOTIFICATION_SCOPE} ${GRIDSPACE_NOTIFICATION_WRITE_SCOPE}` : purpose === 'private-actions' ? `${GRIDSPACE_PRIVATE_SCOPE} ${GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE} ${GRIDSPACE_REPLY_SCOPE} ${GRIDSPACE_ACTION_SCOPE}` : purpose === 'private-full' ? `${GRIDSPACE_PRIVATE_SCOPE} ${GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE} ${GRIDSPACE_REPLY_SCOPE} ${GRIDSPACE_NOTIFICATION_SCOPE} ${GRIDSPACE_NOTIFICATION_WRITE_SCOPE}` : purpose === 'private-notify' ? `${GRIDSPACE_PRIVATE_SCOPE} ${GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE} ${GRIDSPACE_NOTIFICATION_SCOPE} ${GRIDSPACE_NOTIFICATION_WRITE_SCOPE}` : purpose === 'private-reply' ? `${GRIDSPACE_PRIVATE_SCOPE} ${GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE} ${GRIDSPACE_REPLY_SCOPE}` : purpose === 'private-mutual' ? `${GRIDSPACE_PRIVATE_SCOPE} ${GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE}` : purpose === 'private' ? GRIDSPACE_PRIVATE_SCOPE : GRIDSPACE_LINK_SCOPES.join(' '),
			state, code_challenge: gridspaceChallenge(verifier), code_challenge_method: 'S256'
		}).toString();
		return { authorizationUrl: url.href, clientKey };
	}

	public async finish(user: MiLocalUser, input: { state: string; clientKey: string; code: string; issuer: string }): Promise<void> {
		const peer = this.enabled();
		if (input.issuer !== peer.peerOrigin) throw new GridspaceLinkError('INVALID_CALLBACK');
		const linked = await this.guard.run(user.id, async () => {
			const sessions = this.db.getRepository(MiGridspaceAuthSession);
			const session = await sessions.findOneBy({ purpose: In(['link', 'link-all']), localUserId: user.id, stateHash: gridspaceHash(input.state), clientHash: gridspaceHash(input.clientKey) });
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
				const previous = link;
				link = links.create({
					...link, id: link?.id ?? randomUUID(), localUserId: user.id, peerOrigin: peer.peerOrigin,
					peerUserId: identity.id, peerUsername: identity.username, generation: (link?.generation ?? 0) + 1,
					initiator: true, state: 'preparing', tokenCipher: null, privateTokenCipher: null, privateTokenHash: null, privateMutualGrantId: null, privateMutualReady: false, privateRevocationCipher: null, createdAt: link?.createdAt ?? session.createdAt, lastError: null
				});
				try {
					await this.db.transaction(async manager => {
						if (previous) await this.deletePrivateBinding(manager, previous);
						await manager.getRepository(MiGridspaceLink).save(link!);
					});
				} catch { throw new GridspaceLinkError('LINK_CONFLICT'); }
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
				if (session.purpose === 'link') await manager.getRepository(MiGridspaceAuthSession).update(session.id, { completed: true, tokenCipher: null, verifierCipher: '' });
			});
			session.linkId = link.id;
			session.generation = link.generation;
			return { session, link: await this.privateLink(user.id), accessToken };
		});
		if (linked.session.purpose === 'link-all') await this.completePrivateGrant(user, linked);
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
		if (action === 'check' || action === 'palette') {
			const exists = await this.db.getRepository(MiGridspaceLink).existsBy({ id: input.linkId, localUserId: user.id, peerUserId: input.localUserId, peerOrigin: peer.peerOrigin, generation: input.generation, state: 'active' });
			if (!exists) throw new GridspaceLinkError('LINK_REVOKED');
			if (action === 'palette') {
				const token = await this.db.getRepository(MiAccessToken).findOneBy({ token: input.accessToken });
				if (!token?.permission.includes(GRIDSPACE_PALETTE_SCOPE)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				const item = await this.db.getRepository(MiRegistryItem).findOneBy({ userId: user.id, domain: IsNull(), scope: Raw(alias => `${alias} = :paletteScope`, { paletteScope: GRIDSPACE_PALETTE_REGISTRY_SCOPE }), key: GRIDSPACE_PALETTE_REGISTRY_KEY });
				return { userId: user.id, palette: parseGridspacePalette(item?.value) };
			}
			return { ok: true };
		}
		if (action !== 'prepare' || !input.linkId || !input.localUserId || !input.localUsername || !input.generation) throw new GridspaceLinkError('INVALID_CALLBACK');
		return this.guard.run(user.id, () => this.db.transaction('REPEATABLE READ', async manager => {
			await this.authorized(input.accessToken);
			const links = manager.getRepository(MiGridspaceLink);
			let link = await links.findOneBy({ id: input.linkId });
			if (link && (link.localUserId !== user.id || link.peerOrigin !== peer.peerOrigin || link.peerUserId !== input.localUserId || link.initiator)) throw new GridspaceLinkError('LINK_CONFLICT');
			if (link && (input.generation! < link.generation || (link.state === 'revoked' && input.generation === link.generation))) throw new GridspaceLinkError('LINK_REVOKED');
			const generationChanged = link?.generation !== input.generation;
			if (generationChanged && link) await this.deletePrivateBinding(manager, link);
			link = links.create({
					...link, id: input.linkId, localUserId: user.id, peerOrigin: peer.peerOrigin, peerUserId: input.localUserId,
					...(generationChanged ? { privateTokenCipher: null, privateTokenHash: null, privateMutualGrantId: null, privateMutualReady: false, privateRevocationCipher: null } : {}),
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
			if (current && current.state !== 'revoked') await this.commitRevocation(current);
		});
	}

	private async commitRevocation(link: MiGridspaceLink): Promise<void> {
		await this.db.transaction(async manager => {
			await manager.getRepository(MiGridspaceAuthSession).delete({ localUserId: link.localUserId });
			await manager.getRepository(MiAccessToken).delete({ userId: link.localUserId, name: In([link.peerOrigin + GRIDSPACE_CLIENT_PATH, link.peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH]) });
			await manager.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation }, { state: 'revoked', tokenCipher: null, privateTokenCipher: null, privateTokenHash: null, privateMutualGrantId: null, privateMutualReady: false, privateRevocationCipher: null });
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

	public async palette(user: MiLocalUser): Promise<{ peerOrigin: string; peerUserId: string; palette: GridspacePalette | null }> {
		const link = await this.privateLink(user.id);
		if (!link.initiator || !link.tokenCipher) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const tokenCipher = link.tokenCipher;
		const result = await this.json<{ userId: string; palette: unknown }>('/gridspace/v1/link/palette', { linkId: link.id, generation: link.generation, localUserId: user.id, accessToken: openGridspaceSecret(this.enabled(), tokenCipher, link.id) });
		const current = await this.privateLink(user.id);
		if (current.id !== link.id || current.generation !== link.generation || current.tokenCipher !== tokenCipher || result.userId !== link.peerUserId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return { peerOrigin: link.peerOrigin, peerUserId: link.peerUserId, palette: parseGridspacePalette(result.palette) };
	}

	public async privateLink(userId: string): Promise<MiGridspaceLink> {
		const peer = this.enabled();
		const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId: userId, peerOrigin: peer.peerOrigin, state: 'active' });
		const user = await this.db.getRepository(MiUser).findOneBy({ id: userId, host: IsNull(), isSuspended: false, isDeleted: false });
		if (!link || !user) throw new GridspaceLinkError('LINK_REVOKED');
		return link;
	}

	/** The read grant belongs to the viewer's link, never to the profile being viewed. */
	public assertPrivateCaller(token: MiAccessToken | null) {
		// Peer credentials are valid only on signed, pair-bound routes. In particular,
		// an orphaned credential must not consume a later grant through the general API.
		if (token && [GRIDSPACE_CLIENT_PATH, GRIDSPACE_PRIVATE_CLIENT_PATH].some(path => token.name === this.enabled().peerOrigin + path)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
	}

	private async deletePrivateBinding(manager: EntityManager, link: MiGridspaceLink, replacementHash?: string) {
		if (!link.privateTokenHash || link.privateTokenHash === replacementHash) return;
		const tokens = manager.getRepository(MiAccessToken);
		const candidates = await tokens.find({ where: { userId: link.localUserId, name: In([this.enabled().peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, this.enabled().peerOrigin + GRIDSPACE_CLIENT_PATH]) }, select: { id: true, token: true, name: true, permission: true } });
		for (const token of candidates.filter(candidate => gridspaceHash(candidate.token) === link.privateTokenHash)) {
			if (token.name === this.enabled().peerOrigin + GRIDSPACE_CLIENT_PATH) {
				// A combined grant must lose its private scopes too, or it can bind again.
				await tokens.update(token.id, { permission: token.permission.filter(scope => !GRIDSPACE_PRIVATE_SCOPES.includes(scope)) });
			} else {
				await tokens.delete(token.id);
			}
		}
	}

	private async authorizePrivateLocal(input: GridspacePeerLinkRequest, bind = false) {
		const peer = this.enabled();
		if (!input.accessToken || !input.linkId || !input.localUserId || !input.generation) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const token = await this.db.getRepository(MiAccessToken).findOneBy({ token: input.accessToken, name: In([peer.peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, peer.peerOrigin + GRIDSPACE_CLIENT_PATH]) });
		if (!token?.permission.includes(GRIDSPACE_PRIVATE_SCOPE)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const link = await this.privateLink(token.userId);
		if (link.id !== input.linkId || link.generation !== input.generation || link.peerUserId !== input.localUserId ||
			(!bind && ((link.privateMutualGrantId && !link.privateMutualReady) || link.privateTokenHash !== gridspaceHash(input.accessToken) || (link.privateMutualGrantId ?? null) !== (input.pairId ?? null)))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return link;
	}

	public async authorizePrivate(input: GridspacePeerLinkRequest) {
		const link = await this.authorizePrivateLocal(input);
		if (link.privateMutualGrantId) {
			// This endpoint checks only its own DB, so reciprocal checks cannot recurse.
			await this.json('/gridspace/v1/private/pair-check', this.privateCredential(link));
			await this.authorizePrivateLocal(input);
		}
		return link;
	}

	public async hasReplyScope(input: GridspacePeerLinkRequest, manager = this.db.manager): Promise<boolean> {
		if (!input.accessToken) return false;
		const token = await manager.getRepository(MiAccessToken).findOneBy({ token: input.accessToken, name: In([this.enabled().peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, this.enabled().peerOrigin + GRIDSPACE_CLIENT_PATH]) });
		return token?.permission.includes(GRIDSPACE_REPLY_SCOPE) === true;
	}

	public async hasActionScope(input: GridspacePeerLinkRequest, manager = this.db.manager): Promise<boolean> {
		if (!input.accessToken) return false;
		const token = await manager.getRepository(MiAccessToken).findOneBy({ token: input.accessToken, name: In([this.enabled().peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, this.enabled().peerOrigin + GRIDSPACE_CLIENT_PATH]) });
		return token?.permission.includes(GRIDSPACE_ACTION_SCOPE) === true;
	}

	public async hasNotificationScope(input: GridspacePeerLinkRequest): Promise<boolean> {
		if (!input.accessToken) return false;
		const token = await this.db.getRepository(MiAccessToken).findOneBy({ token: input.accessToken, name: In([this.enabled().peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, this.enabled().peerOrigin + GRIDSPACE_CLIENT_PATH]) });
		return !!token && [GRIDSPACE_NOTIFICATION_SCOPE, GRIDSPACE_NOTIFICATION_WRITE_SCOPE].every(scope => token.permission.includes(scope));
	}

	/** Serialize the local commit with grant/token revocation. No peer call holds this lock. */
	public async lockReplyAuthorization(input: GridspacePeerLinkRequest, manager: EntityManager, scope = GRIDSPACE_REPLY_SCOPE) {
		const token = await manager.getRepository(MiAccessToken).findOne({ where: { token: input.accessToken, name: In([this.enabled().peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, this.enabled().peerOrigin + GRIDSPACE_CLIENT_PATH]) }, lock: { mode: 'pessimistic_read' } });
		if (!token?.permission.includes(scope) || !token.permission.includes(GRIDSPACE_PRIVATE_SCOPE)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const link = await manager.getRepository(MiGridspaceLink).findOne({ where: { id: input.linkId }, lock: { mode: 'pessimistic_write' } });
		if (!link || link.localUserId !== token.userId || link.state !== 'active' || link.generation !== input.generation || link.peerUserId !== input.localUserId ||
			link.privateTokenHash !== gridspaceHash(input.accessToken!) || !link.privateMutualReady || link.privateMutualGrantId !== input.pairId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = await manager.getRepository(MiUser).findOne({ where: { id: link.localUserId, host: IsNull() }, lock: { mode: 'pessimistic_read' } });
		if (!user || user.isSuspended || user.isDeleted || user.movedToUri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
	}

	public async peerPrivateGrant(action: string, input: GridspacePeerLinkRequest) {
		if (action === 'check') { await this.authorizePrivate(input); return { ok: true, canReply: await this.hasReplyScope(input), canReadNotifications: await this.hasNotificationScope(input), canInteract: await this.hasActionScope(input) }; }
		if (action === 'pair-check') {
			const link = await this.authorizePrivateLocal(input);
			if (!input.pairId || !link.privateTokenCipher) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return { ok: true };
		}
		const link = await this.authorizePrivateLocal(input, true);
		return this.guard.run(link.localUserId, async () => {
			const current = await this.authorizePrivateLocal(input, true);
			const tokens = this.db.getRepository(MiAccessToken);
			const hash = gridspaceHash(input.accessToken!);
			if (action === 'mutual-probe' || action === 'reciprocal') {
				const token = await tokens.findOneByOrFail({ token: input.accessToken! });
				if (!token.permission.includes(GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE) || current.privateRevocationCipher) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				if (action === 'mutual-probe') return { revision: current.privateRevision, canReply: token.permission.includes(GRIDSPACE_REPLY_SCOPE), canReadNotifications: await this.hasNotificationScope(input), canInteract: await this.hasActionScope(input) };
				if (!input.pairId || !input.reverseToken || input.expectedRevision === undefined) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				if (current.privateMutualGrantId === input.pairId) {
					// An idempotent retry can confirm a live grant, never resurrect a revoked one.
					if (current.privateTokenHash !== hash || this.privateCredential(current).accessToken !== input.reverseToken) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				} else {
					if (current.privateRevision !== input.expectedRevision) throw new GridspaceLinkError('LINK_CONFLICT');
					await this.db.transaction(async manager => {
						await this.deletePrivateBinding(manager, current, hash);
						await manager.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, state: 'active' }, {
							privateMutualGrantId: input.pairId, privateMutualReady: true, privateTokenHash: hash, privateRevision: () => '"privateRevision" + 1',
							privateTokenCipher: sealGridspaceSecret(this.enabled(), input.reverseToken!, `private:${link.id}:${link.generation}`),
						});
					});
				}
			}
			if (action === 'authorize') {
				if (current.privateMutualGrantId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				await this.db.transaction(async manager => {
					await this.deletePrivateBinding(manager, current, hash);
					await manager.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, state: 'active' }, { privateTokenHash: hash, privateRevision: () => '"privateRevision" + 1' });
				});
			}
			if (action === 'revoke') {
				await this.db.transaction(async manager => {
					if (current.privateTokenHash === hash && (current.privateMutualGrantId ?? null) === (input.pairId ?? null)) {
						await manager.getRepository(MiGridspaceLink).update(link.id, { privateTokenHash: null, privateRevision: () => '"privateRevision" + 1', ...(current.privateMutualGrantId ? { privateTokenCipher: null } : {}) });
						if (current.privateMutualGrantId) await manager.getRepository(MiGridspaceAuthSession).delete({ localUserId: link.localUserId, purpose: In(['link-all', 'private', 'private-mutual', 'private-reply', 'private-notify', 'private-full', 'private-actions', 'private-all']) });
					}
					await this.deletePrivateBinding(manager, { ...current, privateTokenHash: hash });
				});
			}
			return { ok: true };
		});
	}

	public async finishPrivate(user: MiLocalUser, input: { state: string; clientKey: string; code: string; issuer: string }): Promise<void> {
		const peer = this.enabled();
		if (input.issuer !== peer.peerOrigin) throw new GridspaceLinkError('INVALID_CALLBACK');
		const prepared = await this.guard.run(user.id, async () => {
			const sessions = this.db.getRepository(MiGridspaceAuthSession);
			const session = await sessions.findOneBy({ purpose: In(['private', 'private-mutual', 'private-reply', 'private-notify', 'private-full', 'private-actions', 'private-all']), localUserId: user.id, stateHash: gridspaceHash(input.state), clientHash: gridspaceHash(input.clientKey) });
			const link = await this.privateLink(user.id);
			if (!session || session.completed || link.privateRevocationCipher || session.expiresAt.getTime() < Date.now() || session.linkId !== link.id || session.generation !== link.generation) throw new GridspaceLinkError('INVALID_CALLBACK');
			if (!session.tokenCipher) {
				if (session.exchanged) throw new GridspaceLinkError('INVALID_CALLBACK');
				await sessions.update(session.id, { exchanged: true });
				const token = await this.json<{ access_token: string; token_type: string }>('/oauth/token', {
					grant_type: 'authorization_code', code: input.code, client_id: peer.origin + GRIDSPACE_PRIVATE_CLIENT_PATH,
					redirect_uri: peer.origin + GRIDSPACE_CALLBACK_PATH, code_verifier: openGridspaceSecret(peer, session.verifierCipher, session.id),
				}, false);
				if (typeof token.access_token !== 'string' || token.token_type !== 'Bearer') throw new GridspaceLinkError('INVALID_CALLBACK');
				session.tokenCipher = sealGridspaceSecret(peer, token.access_token, session.id);
				await sessions.update(session.id, { tokenCipher: session.tokenCipher });
			}
			const accessToken = openGridspaceSecret(peer, session.tokenCipher, session.id);
			return { session, link, accessToken };
		});
		await this.completePrivateGrant(user, prepared);
	}

	private async completePrivateGrant(user: MiLocalUser, prepared: { session: MiGridspaceAuthSession; link: MiGridspaceLink; accessToken: string }): Promise<void> {
		const peer = this.enabled();
		const { session, link, accessToken } = prepared;
		const credential = { linkId: link.id, generation: link.generation, localUserId: user.id, accessToken };
		if (session.purpose !== 'private') {
			const probe = session.privateGrant ? null : await this.json<{ revision: number; canReply?: boolean; canReadNotifications?: boolean; canInteract?: boolean }>('/gridspace/v1/private/mutual-probe', credential);
			if (probe && ['link-all', 'private-reply', 'private-full', 'private-actions', 'private-all'].includes(session.purpose) && !probe.canReply) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			if (probe && ['link-all', 'private-actions', 'private-all'].includes(session.purpose) && !probe.canInteract) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			if (probe && ['link-all', 'private-notify', 'private-full', 'private-all'].includes(session.purpose) && !probe.canReadNotifications) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			const grant = await this.guard.run(user.id, async () => {
				const current = await this.privateSession(session);
				const saved = await this.db.getRepository(MiGridspaceAuthSession).findOneByOrFail({ id: session.id });
				if (saved.privateGrant) {
					const token = await this.db.getRepository(MiAccessToken).findOneBy({ id: saved.privateGrant.reverseTokenId, userId: user.id });
					if (!token || current.privateMutualGrantId !== session.id || current.privateTokenHash !== gridspaceHash(token.token) || this.privateCredential(current).accessToken !== accessToken) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
					return { reverseToken: token.token, expectedRevision: saved.privateGrant.expectedPeerRevision };
				}
				if (!probe || !Number.isSafeInteger(probe.revision) || current.privateRevision !== link.privateRevision) throw new GridspaceLinkError('LINK_CONFLICT');
				const token = randomBytes(32).toString('base64url');
				const tokenId = this.ids.gen();
				await this.db.transaction(async manager => {
					await this.deletePrivateBinding(manager, current);
					// No MiAuth session: these credentials must never be retrievable anonymously.
					await manager.getRepository(MiAccessToken).insert({ id: tokenId, userId: user.id, token, hash: token, fetched: true,
						name: peer.peerOrigin + GRIDSPACE_PRIVATE_CLIENT_PATH, permission: [GRIDSPACE_PRIVATE_SCOPE] });
					await manager.getRepository(MiGridspaceLink).update(link.id, { privateMutualGrantId: session.id, privateMutualReady: false, privateTokenHash: gridspaceHash(token), privateRevision: () => '"privateRevision" + 1',
						privateTokenCipher: sealGridspaceSecret(peer, accessToken, `private:${link.id}:${link.generation}`) });
					await manager.getRepository(MiGridspaceAuthSession).update(session.id, { privateGrant: { reverseTokenId: tokenId, expectedPeerRevision: probe.revision } });
				});
				return { reverseToken: token, expectedRevision: probe.revision };
			});
			// Peer calls never hold the local user's guard: simultaneous flows cannot deadlock.
			await this.json('/gridspace/v1/private/reciprocal', { ...credential, pairId: session.id, ...grant });
			await this.json('/gridspace/v1/private/pair-check', { ...credential, pairId: session.id });
		} else {
			if (link.privateMutualGrantId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			await this.json('/gridspace/v1/private/authorize', credential);
		}
		await this.guard.run(user.id, async () => {
			const current = await this.privateSession(session);
			if (session.purpose !== 'private') {
				if (current.privateMutualGrantId !== session.id || this.privateCredential(current).accessToken !== accessToken) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			} else {
				if (current.privateMutualGrantId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
				await this.db.getRepository(MiGridspaceLink).update(link.id, { privateTokenCipher: sealGridspaceSecret(peer, accessToken, `private:${link.id}:${link.generation}`), privateRevision: () => '"privateRevision" + 1' });
			}
			await this.db.transaction(async manager => {
				const completed = await manager.getRepository(MiGridspaceAuthSession).update({ id: session.id, completed: false }, { completed: true, tokenCipher: null, verifierCipher: '' });
				if (!completed.affected) throw new GridspaceLinkError('INVALID_CALLBACK');
				if (session.purpose !== 'private') await manager.getRepository(MiGridspaceLink).update(link.id, { privateMutualReady: true });
			});
		});
	}

	private async privateSession(session: MiGridspaceAuthSession) {
		const saved = await this.db.getRepository(MiGridspaceAuthSession).findOneBy({ id: session.id, completed: false });
		const link = await this.privateLink(session.localUserId);
		if (!saved || saved.expiresAt.getTime() < Date.now() || link.id !== session.linkId || link.generation !== session.generation || link.privateRevocationCipher) throw new GridspaceLinkError('INVALID_CALLBACK');
		return link;
	}

	public privateCredential(link: MiGridspaceLink): GridspacePeerLinkRequest {
		if (!link.privateTokenCipher) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return { linkId: link.id, generation: link.generation, localUserId: link.localUserId, ...(link.privateMutualGrantId ? { pairId: link.privateMutualGrantId } : {}),
			accessToken: openGridspaceSecret(this.enabled(), link.privateTokenCipher, `private:${link.id}:${link.generation}`) };
	}

	public async checkPrivateUnchanged(link: MiGridspaceLink) {
		const current = await this.privateLink(link.localUserId);
		if (current.id !== link.id || current.generation !== link.generation || !current.privateTokenCipher || current.privateTokenCipher !== link.privateTokenCipher) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
	}

	public async privateStatus(user: MiLocalUser) {
		const peer = this.peer;
		const result = { enabled: !!peer, granted: false, mutual: false, canReply: false, canReadNotifications: false, canInteract: false, available: true, peerOrigin: peer?.peerOrigin ?? null, authorizationUrl: null as string | null, clientKey: null as string | null };
		if (!peer) return result;
		try {
			const link = await this.privateLink(user.id);
			if (!link.privateTokenCipher) return result;
			result.granted = true;
			const checked = await this.json<{ canReply?: boolean; canReadNotifications?: boolean; canInteract?: boolean }>('/gridspace/v1/private/check', this.privateCredential(link));
			await this.checkPrivateUnchanged(link);
			result.granted = true;
			result.mutual = !!link.privateMutualGrantId;
			result.canReply = checked.canReply === true;
			result.canInteract = checked.canInteract === true;
			result.canReadNotifications = checked.canReadNotifications === true;
		} catch (error) {
			if (!(error instanceof GridspaceLinkError) || error.code === 'PEER_UNAVAILABLE') result.available = false;
			else result.granted = false;
		}
		return result;
	}

	public async revokePrivate(user: MiLocalUser) {
		const pendingLink = await this.guard.run(user.id, async () => {
			await this.db.getRepository(MiGridspaceAuthSession).delete({ localUserId: user.id, purpose: In(['link-all', 'private', 'private-mutual', 'private-reply', 'private-notify', 'private-full', 'private-actions', 'private-all']) });
			const link = await this.privateLink(user.id);
			const pending = link.privateTokenCipher ?? link.privateRevocationCipher;
			await this.db.transaction(async manager => {
				if (link.privateMutualGrantId) await this.deletePrivateBinding(manager, link);
				await manager.getRepository(MiGridspaceLink).update(link.id, { privateTokenCipher: null, privateRevocationCipher: pending, privateRevision: () => '"privateRevision" + 1', ...(link.privateMutualGrantId ? { privateTokenHash: null } : {}) });
			});
			return { ...link, privateRevocationCipher: pending };
		});
		try { await this.sendPrivateRevocation(pendingLink); } catch { throw new GridspaceLinkError('REVOKE_PENDING'); }
	}

	private async sendPrivateRevocation(link: MiGridspaceLink) {
		if (!link.privateRevocationCipher) return;
		try { await this.json('/gridspace/v1/private/revoke', this.privateCredential({ ...link, privateTokenCipher: link.privateRevocationCipher })); } catch (error) { if (!(error instanceof GridspaceLinkError) || !['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code)) throw error; }
		await this.db.getRepository(MiGridspaceLink).update({ id: link.id, generation: link.generation, privateRevocationCipher: link.privateRevocationCipher }, { privateRevocationCipher: null });
	}

	private async work(): Promise<void> {
		if (this.working || !this.peer) return;
		this.working = true;
		try {
			await this.db.getRepository(MiGridspaceAuthSession).delete({ expiresAt: LessThan(new Date()) });
			const revocations = await this.db.getRepository(MiGridspaceLink).createQueryBuilder('link').where('link.privateRevocationCipher IS NOT NULL').take(10).getMany();
			for (const link of revocations) {
				try { await this.sendPrivateRevocation(link); } catch { break; /* Retry next pass; reads already disabled. */ }
			}
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
