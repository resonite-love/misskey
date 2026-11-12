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
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';

type Candidate = { followerId: string; targetId: string; sourceId: string };

/** Adds a local counterpart once; it never synchronizes later unfollows between actors. */
@Injectable()
export class GridspaceFollowExpansionService implements OnModuleInit, OnApplicationShutdown {
	private peer: GridspacePeerConfig | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;
	private cursor: Pick<Candidate, 'followerId' | 'targetId'> | null = null;

	constructor(
		@Inject(DI.config) config: Config,
		@Inject(DI.db) private db: DataSource,
		private following: UserFollowingService,
		private links: GridspaceLinkService,
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

	private async work(): Promise<void> {
		if (!this.peer || this.working) return;
		this.working = true;
		try {
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

	private async expand(candidate: Candidate): Promise<void> {
		if (!this.peer) return;
		const peer = this.peer;
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
