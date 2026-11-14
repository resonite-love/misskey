/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser } from '@/models/User.js';
import { MiFollowing } from '@/models/Following.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { MiMuting } from '@/models/Muting.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiGridspaceFollowExpansion, MiGridspaceFollowOverride, MiGridspaceLink } from '@/models/Gridspace.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { openGridspaceSecret } from './link-crypto.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';

type Candidate = { followerId: string; targetId: string; sourceId: string };
type SourceCandidate = { followerId: string; sourceId: string; linkId: string; generation: number };

/** Adds a local counterpart once; it never synchronizes later unfollows between actors. */
@Injectable()
export class GridspaceFollowExpansionService implements OnModuleInit, OnApplicationShutdown {
	private peer: GridspacePeerConfig | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;
	private cursor: Pick<Candidate, 'followerId' | 'targetId'> | null = null;
	private sourceCursor: Pick<SourceCandidate, 'followerId' | 'sourceId'> | null = null;
	private sourceSide: boolean;
	private resolutionRetry = new Map<string, number>();
	private refreshedProfiles = new Set<string>();
	private profileReadiness = new Map<string, number>();

	constructor(
		@Inject(DI.config) config: Config,
		@Inject(DI.db) private db: DataSource,
		private following: UserFollowingService,
		private links: GridspaceLinkService,
		private guard: GridspaceFollowGuardService,
		private history: GridspaceHistoryService,
		private people: ApPersonService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.sourceSide = config.gridspace?.channelRole === 'source';
	}

	public onModuleInit(): void {
		if (!this.peer) return;
		this.timer = setInterval(() => { void this.work(); }, 3000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	private async work(): Promise<void> {
		if (!this.peer || this.working) return;
		this.working = true;
		try {
			if (this.sourceSide) { await this.workSource(); return; }
			// Both links must have been initiated here. A mirrored source-side link is
			// not permission to change the source account's subscriptions.
			const candidates = await this.db.query<Candidate[]>(`
				SELECT DISTINCT viewer."localUserId" AS "followerId", target."localUserId" AS "targetId", source.id AS "sourceId"
				FROM gridspace_link viewer
				JOIN (
					SELECT "followerId", "followeeId" FROM following
					UNION ALL SELECT "followerId", "followeeId" FROM follow_request
				) subscription ON subscription."followerId" = viewer."localUserId"
				JOIN "user" source ON source.id = subscription."followeeId" AND source.host = $2
				JOIN gridspace_link target ON source.uri = $1 || '/users/' || target."peerUserId"
				LEFT JOIN gridspace_follow_expansion receipt ON receipt."followerId" = viewer."localUserId" AND receipt."targetId" = target."localUserId"
				WHERE viewer.state = 'active' AND viewer.initiator = TRUE AND viewer."peerOrigin" = $1
				AND target.state = 'active' AND target.initiator = TRUE AND target."peerOrigin" = $1
				AND viewer."localUserId" <> target."localUserId"
				AND (receipt."followerId" IS NULL OR (receipt.state = 'pending' AND receipt."retryAt" <= NOW()))
				AND ($3::varchar IS NULL OR (viewer."localUserId", target."localUserId") > ($3, $4))
				ORDER BY "followerId", "targetId" LIMIT 20
			`, [this.peer.peerOrigin, new URL(this.peer.peerOrigin).host, this.cursor?.followerId ?? null, this.cursor?.targetId ?? null]);
			this.cursor = candidates.at(-1) ?? null;
			for (const candidate of candidates) {
				try { await this.expand(candidate); } catch { /* A database outage must not starve the remaining page. */ }
			}
		} catch { /* Retry discovery after startup or database recovery. */ } finally { this.working = false; }
	}

	private async workSource(): Promise<void> {
		const peer = this.peer!;
		const candidates = await this.db.query<SourceCandidate[]>(`
			SELECT subscription."followerId", target."localUserId" AS "sourceId", target.id AS "linkId", target.generation
			FROM gridspace_link target
			JOIN "user" source ON source.id = target."localUserId" AND source.host IS NULL
			JOIN following subscription ON subscription."followeeId" = source.id
			JOIN "user" viewer ON viewer.id = subscription."followerId" AND viewer.host IS NULL
			LEFT JOIN "user" remote ON remote.uri = $1 || '/users/' || target."peerUserId" AND remote.host = $2
			LEFT JOIN gridspace_follow_expansion receipt ON receipt."followerId" = viewer.id AND receipt."targetId" = remote.id
			WHERE target.state = 'active' AND target.initiator = FALSE AND target."peerOrigin" = $1
			AND viewer.id <> source.id
			AND (receipt."followerId" IS NULL OR (receipt.state = 'pending' AND receipt."retryAt" <= NOW()))
			AND ($3::varchar IS NULL OR (viewer.id, source.id) > ($3, $4))
			ORDER BY viewer.id, source.id LIMIT 20
		`, [peer.peerOrigin, new URL(peer.peerOrigin).host, this.sourceCursor?.followerId ?? null, this.sourceCursor?.sourceId ?? null]);
		this.sourceCursor = candidates.at(-1) ?? null;
		for (const candidate of candidates) {
			try { await this.expandSource(candidate); } catch { /* Retry independent followers after recovery. */ }
		}
	}

	private async expandSource(candidate: SourceCandidate): Promise<void> {
		const peer = this.peer!;
		await this.guard.runMany([candidate.followerId, candidate.sourceId], async () => {
			const { followerId, sourceId } = candidate;
			const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: candidate.linkId, generation: candidate.generation, localUserId: sourceId, peerOrigin: peer.peerOrigin, initiator: false, state: 'active' });
			if (!link) return;
			const users = this.db.getRepository(MiUser);
			const user = await users.findOneBy({ id: followerId, host: IsNull() });
			const source = await users.findOneBy({ id: sourceId, host: IsNull() });
			const subscription = await this.db.getRepository(MiFollowing).findOneBy({ followerId, followeeId: sourceId });
			if (!user || !source || !subscription || followerId === sourceId) return;
			if ((this.resolutionRetry.get(sourceId) ?? 0) > Date.now()) return;
			// Do not discover/cache the destination actor while it still has its default profile.
			const profileKey = `${link.id}:${link.generation}`;
			const readyAt = this.profileReadiness.get(profileKey) ?? 0;
			if (readyAt !== Infinity) {
				if (readyAt > Date.now()) return;
				let readiness: { ready: boolean };
				try { readiness = await this.links.json<{ ready: boolean }>('/gridspace/v1/link/profile-ready', { linkId: link.id, generation: link.generation, localUserId: sourceId }); } catch { this.resolutionRetry.set(sourceId, Date.now() + 60000); return; }
				this.profileReadiness.set(profileKey, readiness.ready ? Infinity : Date.now() + 30000);
				if (!readiness.ready) return;
			}
			const uri = `${peer.peerOrigin}/users/${link.peerUserId}`;
			let target = await users.findOneBy({ uri, host: new URL(peer.peerOrigin).host });
			if (target && !this.refreshedProfiles.has(profileKey)) {
				try { await this.people.updatePerson(uri); } catch { this.resolutionRetry.set(sourceId, Date.now() + 60000); return; }
				target = await users.findOneBy({ uri, host: new URL(peer.peerOrigin).host });
			}
			if (!target) {
				if ((this.resolutionRetry.get(sourceId) ?? 0) > Date.now()) return;
				try { target = await this.people.resolvePerson(uri); this.resolutionRetry.delete(sourceId); } catch { this.resolutionRetry.set(sourceId, Date.now() + 60000); return; }
			}
			if (target.uri !== uri || target.host !== new URL(peer.peerOrigin).host) return;
			this.refreshedProfiles.add(profileKey);
			const key = { followerId, targetId: target.id };
			const receipts = this.db.getRepository(MiGridspaceFollowExpansion);
			const receipt = await receipts.findOneBy(key);
			if (receipt && (receipt.state !== 'pending' || receipt.retryAt.getTime() > Date.now())) return;
			await receipts.upsert({ ...key, state: 'pending', reason: null, attempts: receipt?.attempts ?? 0, retryAt: new Date() }, ['followerId', 'targetId']);
			const complete = (state: 'done' | 'skipped', reason: string | null = null) => receipts.update(key, { state, reason });
			try {
				const destination = { followerId, followeeId: target.id };
				if (await this.db.getRepository(MiFollowing).existsBy(destination) || await this.db.getRepository(MiFollowRequest).existsBy(destination)) { await complete('done'); return; }
				if (await this.db.getRepository(MiGridspaceFollowOverride).existsBy({ localUserId: followerId, targetUserId: target.id })) { await complete('skipped', 'USER_UNFOLLOWED'); return; }
				const ids = [sourceId, target.id];
				const blocked = await this.db.getRepository(MiBlocking).exists({ where: [{ blockerId: followerId, blockeeId: In(ids) }, { blockerId: In(ids), blockeeId: followerId }] });
				const mutes = await this.db.getRepository(MiMuting).findBy({ muterId: followerId, muteeId: In(ids) });
				if ([user, source, target].some(account => account.isSuspended || account.isDeleted || account.movedToUri) || blocked || mutes.some(mute => !mute.expiresAt || mute.expiresAt.getTime() > Date.now())) { await complete('skipped', 'TARGET_RESTRICTED'); return; }
				if (!await this.history.verifyLink(link)) throw new Error('Link unavailable');
				await this.following.follow(user, target, { withReplies: subscription.withReplies });
				await complete('done');
			} catch {
				const attempts = (receipt?.attempts ?? 0) + 1;
				await receipts.update(key, { attempts, reason: 'FOLLOW_FAILED', retryAt: new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(attempts, 7))) });
			}
		});
	}

	private async expand(candidate: Candidate): Promise<void> {
		if (!this.peer) return;
		const peer = this.peer;
		// Profile imports take the profile lock. Never do this under following locks:
		// settings import takes those locks in the opposite order while copying blocks.
		const prepared = await Promise.all([candidate.followerId, candidate.targetId].map(localUserId =>
			this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId, peerOrigin: peer.peerOrigin, state: 'active', initiator: true })));
		let profileFailed = false;
		try {
			for (const link of prepared) {
				if (!link) throw new Error('Link unavailable');
				await this.links.ensureProfileBeforeFollowing(link);
			}
		} catch { profileFailed = true; }
		await this.guard.runMany([candidate.followerId, candidate.targetId], async () => {
			const { followerId, targetId, sourceId } = candidate;
			const key = { followerId, targetId };
			const receipts = this.db.getRepository(MiGridspaceFollowExpansion);
			const receipt = await receipts.findOneBy(key);
			if (receipt && (receipt.state !== 'pending' || receipt.retryAt.getTime() > Date.now())) return;
			const links = this.db.getRepository(MiGridspaceLink);
			const viewer = await links.findOneBy({ localUserId: followerId, peerOrigin: peer.peerOrigin, state: 'active', initiator: true });
			const targetLink = await links.findOneBy({ localUserId: targetId, peerOrigin: peer.peerOrigin, state: 'active', initiator: true });
			if (!viewer?.tokenCipher || !targetLink?.tokenCipher) return;
			const users = this.db.getRepository(MiUser);
			const user = await users.findOneBy({ id: followerId, host: IsNull() });
			const target = await users.findOneBy({ id: targetId, host: IsNull() });
			const source = await users.findOneBy({ id: sourceId, host: new URL(peer.peerOrigin).host, uri: `${peer.peerOrigin}/users/${targetLink.peerUserId}` });
			const subscriptions = this.db.getRepository(MiFollowing);
			const requests = this.db.getRepository(MiFollowRequest);
			const sourceKey = { followerId, followeeId: sourceId };
			const subscription = await subscriptions.findOneBy(sourceKey) ?? await requests.findOneBy(sourceKey);
			if (!user || !target || !source || !subscription || followerId === targetId) return;
			await receipts.upsert({ ...key, state: 'pending', reason: null, attempts: receipt?.attempts ?? 0, retryAt: new Date() }, ['followerId', 'targetId']);
			const complete = (state: 'done' | 'skipped', reason: string | null = null) => receipts.update(key, { state, reason });
			try {
				if (profileFailed || [viewer, targetLink].some((link, index) => !prepared[index] ||
					link.id !== prepared[index]!.id || link.generation !== prepared[index]!.generation || link.tokenCipher !== prepared[index]!.tokenCipher)) throw new Error('Profile pending');
				const destinationKey = { followerId, followeeId: targetId };
				if (await subscriptions.existsBy(destinationKey) || await requests.existsBy(destinationKey)) {
					await complete('done'); return;
				}
				if (await this.db.getRepository(MiGridspaceFollowOverride).existsBy({ localUserId: followerId, targetUserId: targetId })) {
					await complete('skipped', 'USER_UNFOLLOWED'); return;
				}
				const blocked = await this.db.getRepository(MiBlocking).exists({ where: [
					{ blockerId: followerId, blockeeId: In([sourceId, targetId]) },
					{ blockerId: In([sourceId, targetId]), blockeeId: followerId },
				] });
				const mutes = await this.db.getRepository(MiMuting).findBy({ muterId: followerId, muteeId: In([sourceId, targetId]) });
				if ([user, target, source].some(account => account.isSuspended || account.isDeleted || account.movedToUri) || blocked ||
					mutes.some(mute => !mute.expiresAt || mute.expiresAt.getTime() > Date.now())) {
					await complete('skipped', 'TARGET_RESTRICTED'); return;
				}
				for (const link of [viewer, targetLink]) {
					await this.links.json('/gridspace/v1/link/check', {
						linkId: link.id, localUserId: link.localUserId, generation: link.generation,
						accessToken: openGridspaceSecret(peer, link.tokenCipher!, link.id),
					});
				}
				// The normal service preserves locked-account approval, notifications and
				// follower caches. withReplies is copied without changing an existing follow.
				await this.following.follow(user, target, { withReplies: subscription.withReplies });
				await complete('done');
			} catch {
				const attempts = (receipt?.attempts ?? 0) + 1;
				await receipts.update(key, { attempts, reason: 'FOLLOW_FAILED', retryAt: new Date(Date.now() + Math.min(300_000, 3000 * 2 ** Math.min(attempts, 7))) });
			}
		});
	}
}
