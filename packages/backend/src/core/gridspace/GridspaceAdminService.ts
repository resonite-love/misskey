/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiUser } from '@/models/User.js';
import { MiGridspaceFollowExpansion, MiGridspaceImportItem, MiGridspaceLink, MiGridspaceNoteDelivery } from '@/models/Gridspace.js';
import { IdService } from '@/core/IdService.js';
import { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { resolveGridspaceConfig, GRIDSPACE_PROTOCOL_VERSION } from './peer-protocol.js';
import { GridspaceProtocolMismatch, requestGridspacePeer } from './peer-client.js';
import { adminReason, type AdminJob, type AdminJobKind, type AdminRetry } from './admin-protocol.js';

@Injectable()
export class GridspaceAdminService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.db) private db: DataSource,
		private guard: GridspaceFollowGuardService,
		private ids: IdService,
	) {}

	public async status() {
		const peer = resolveGridspaceConfig(this.config.gridspace, this.config.url, process.env);
		let connection: 'ok' | 'unavailable' | 'incompatible' | 'disabled' = 'disabled';
		let latencyMs: number | null = null;
		if (peer) {
			const start = Date.now();
			try {
				const response = await requestGridspacePeer(peer, '/gridspace/v1/handshake', { protocolVersion: GRIDSPACE_PROTOCOL_VERSION }, 8192, start + 3000) as Record<string, unknown>;
				connection = response.protocolVersion === GRIDSPACE_PROTOCOL_VERSION && response.origin === peer.peerOrigin && response.peerOrigin === peer.origin && response.communityId === peer.communityId ? 'ok' : 'incompatible';
				latencyMs = Date.now() - start;
			} catch (error) { connection = error instanceof GridspaceProtocolMismatch ? 'incompatible' : 'unavailable'; }
		}
		const [counts] = await this.db.query<Record<'linksActive' | 'linksPreparing' | 'linksRevoked' | 'linksWithErrors' | 'importsPending' | 'importsFailed' | 'importsRequested' | 'expansionsPending' | 'expansionsRetrying' | 'deliveriesPending' | 'deliveriesRetrying' | 'revocationsPending' | 'privateRevocationsPending', number>[]>(`SELECT
			(SELECT COUNT(*)::int FROM gridspace_link WHERE state='active') AS "linksActive",
			(SELECT COUNT(*)::int FROM gridspace_link WHERE state='preparing') AS "linksPreparing",
			(SELECT COUNT(*)::int FROM gridspace_link WHERE state='revoked') AS "linksRevoked",
			(SELECT COUNT(*)::int FROM gridspace_link WHERE "lastError" IS NOT NULL) AS "linksWithErrors",
			(SELECT COUNT(*)::int FROM gridspace_link WHERE "lastError"='REVOKE_PENDING') AS "revocationsPending",
			(SELECT COUNT(*)::int FROM gridspace_link WHERE "privateRevocationCipher" IS NOT NULL) AS "privateRevocationsPending",
			(SELECT COUNT(*)::int FROM gridspace_import_item WHERE state='pending') AS "importsPending",
			(SELECT COUNT(*)::int FROM gridspace_import_item WHERE state='failed') AS "importsFailed",
			(SELECT COUNT(*)::int FROM gridspace_import_item i JOIN gridspace_link l ON l.id=i."linkId" WHERE i.state='requested' AND EXISTS(SELECT 1 FROM follow_request f WHERE f."followerId"=l."localUserId" AND f."followeeId"=i."targetUserId")) AS "importsRequested",
			(SELECT COUNT(*)::int FROM gridspace_follow_expansion WHERE state='pending') AS "expansionsPending",
			(SELECT COUNT(*)::int FROM gridspace_follow_expansion WHERE state='pending' AND reason='FOLLOW_FAILED') AS "expansionsRetrying",
			(SELECT COUNT(*)::int FROM gridspace_note_delivery) AS "deliveriesPending",
			(SELECT COUNT(*)::int FROM gridspace_note_delivery WHERE attempts>0) AS "deliveriesRetrying"
		`);
		return { ...counts, enabled: !!peer, origin: this.config.url, peerOrigin: peer?.peerOrigin ?? null, checkedAt: new Date().toISOString(), connection, latencyMs };
	}

	public async links(input: { after?: string; userId?: string; issuesOnly: boolean; limit: number }) {
		// Explicit projection: never serialize the link entity or its encrypted grants.
		const rows = await this.db.query<{
			id: string; localUserId: string; localUsername: string; peerUserId: string; peerUsername: string;
			peerOrigin: string; generation: number; state: string; initiator: boolean; lastError: string | null;
			createdAt: Date; privateReadEnabled: boolean; privateRevocationPending: boolean;
		}[]>(`SELECT l.id,l."localUserId",u.username AS "localUsername",l."peerUserId",l."peerUsername",l."peerOrigin",
			l.generation,l.state,l.initiator,l."lastError",l."createdAt",
			(l.state='active' AND l."privateTokenCipher" IS NOT NULL) AS "privateReadEnabled",
			(l."privateRevocationCipher" IS NOT NULL) AS "privateRevocationPending"
			FROM gridspace_link l JOIN "user" u ON u.id=l."localUserId"
			WHERE ($1::uuid IS NULL OR l.id>$1) AND ($2::varchar IS NULL OR l."localUserId"=$2)
			AND (NOT $3 OR l."lastError" IS NOT NULL OR l."privateRevocationCipher" IS NOT NULL
			 OR EXISTS(SELECT 1 FROM gridspace_import_item i WHERE i."linkId"=l.id AND i.state='failed')
			 OR EXISTS(SELECT 1 FROM gridspace_follow_expansion e WHERE e."followerId"=l."localUserId" AND e.state='pending' AND e.reason='FOLLOW_FAILED'))
			ORDER BY l.id LIMIT $4`, [input.after ?? null, input.userId ?? null, input.issuesOnly, input.limit + 1]);
		return { items: rows.slice(0, input.limit).map(row => ({ ...row, lastError: adminReason(row.lastError), createdAt: row.createdAt.toISOString() })), next: rows.length > input.limit ? rows[input.limit - 1].id : null };
	}

	public async jobs(input: { kind: AdminJobKind; after?: string; userId?: string; failedOnly: boolean; limit: number }) {
		const peer = resolveGridspaceConfig(this.config.gridspace, this.config.url, process.env);
		const params = [input.after ?? null, input.userId ?? null, input.failedOnly, input.limit + 1, peer?.peerOrigin ?? null];
		let rows: (Omit<AdminJob, 'retryAt'> & { retryAt: Date | null })[];
		if (input.kind === 'import') {
			rows = await this.db.query(`SELECT i.id::text,'import' AS kind,l."localUserId",u.username AS "localUsername",i."actorUri" AS target,
				i.state,i.reason,0 AS attempts,NULL AS "retryAt",l.generation,NULL AS version,
				(i.state='failed' AND l.state='active' AND l.initiator AND l."peerOrigin"=$5) AS "canRetry"
				FROM gridspace_import_item i JOIN gridspace_link l ON l.id=i."linkId" JOIN "user" u ON u.id=l."localUserId"
				WHERE ($1::text IS NULL OR i.id::text>$1) AND ($2::varchar IS NULL OR l."localUserId"=$2)
				AND (NOT $3 OR i.state='failed') ORDER BY i.id::text LIMIT $4`, params);
		} else if (input.kind === 'expansion') {
			rows = await this.db.query(`SELECT e."followerId" || ':' || e."targetId" AS id,'expansion' AS kind,e."followerId" AS "localUserId",
				u.username AS "localUsername",t.username AS target,e.state,e.reason,e.attempts,e."retryAt",NULL AS generation,NULL AS version,
				(e.state='pending' AND e.reason='FOLLOW_FAILED' AND e."retryAt">NOW() AND (SELECT COUNT(*) FROM gridspace_link l WHERE l."localUserId" IN (e."followerId", e."targetId") AND l.state='active' AND l.initiator AND l."peerOrigin"=$5)=2) AS "canRetry"
				FROM gridspace_follow_expansion e JOIN "user" u ON u.id=e."followerId" JOIN "user" t ON t.id=e."targetId"
				WHERE ($1::text IS NULL OR e."followerId" || ':' || e."targetId">$1) AND ($2::varchar IS NULL OR e."followerId"=$2)
				AND (NOT $3 OR (e.state='pending' AND e.reason='FOLLOW_FAILED')) ORDER BY id LIMIT $4`, params);
		} else {
			rows = await this.db.query(`SELECT d."noteId" AS id,'delivery' AS kind,n."userId" AS "localUserId",u.username AS "localUsername",
				d."noteId" AS target,'pending' AS state,CASE WHEN d.attempts>0 THEN 'DELIVERY_FAILED' ELSE NULL END AS reason,
				d.attempts,d."retryAt",NULL AS generation,d.version::text,(d.attempts>0 AND d."retryAt">NOW() AND d."peerOrigin"=$5) AS "canRetry"
				FROM gridspace_note_delivery d LEFT JOIN note n ON n.id=d."noteId" LEFT JOIN "user" u ON u.id=n."userId"
				WHERE ($1::text IS NULL OR d."noteId">$1) AND ($2::varchar IS NULL OR n."userId"=$2)
				AND (NOT $3 OR d.attempts>0) ORDER BY d."noteId" LIMIT $4`, params);
		}
		const enabled = this.config.gridspace?.enabled === true;
		return { items: rows.slice(0, input.limit).map(row => ({ ...row, reason: adminReason(row.reason), retryAt: row.retryAt?.toISOString() ?? null, canRetry: enabled && row.canRetry })), next: rows.length > input.limit ? rows[input.limit - 1].id : null };
	}

	private async audit(manager: EntityManager, admin: MiUser, input: AdminRetry) {
		await manager.query('INSERT INTO moderation_log (id, "userId", type, info) VALUES ($1, $2, $3, $4::jsonb)', [this.ids.gen(), admin.id, 'retryGridspaceJob', JSON.stringify({ kind: input.kind, jobId: input.id })]);
	}

	public async retry(admin: MiUser, input: AdminRetry): Promise<boolean> {
		const peer = resolveGridspaceConfig(this.config.gridspace, this.config.url, process.env);
		if (!peer) return false;
		if (input.kind === 'import') {
			if (!input.generation || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.id)) return false;
			const item = await this.db.getRepository(MiGridspaceImportItem).findOneBy({ id: input.id });
			const link = item && await this.db.getRepository(MiGridspaceLink).findOneBy({ id: item.linkId });
			if (!item || !link) return false;
			return this.guard.run(link.localUserId, () => this.db.transaction(async manager => {
				if (!await manager.getRepository(MiGridspaceLink).existsBy({ id: link.id, generation: input.generation, state: 'active', initiator: true, peerOrigin: peer.peerOrigin })) return false;
				const result = await manager.getRepository(MiGridspaceImportItem).update({ id: item.id, state: 'failed' }, { state: 'pending', reason: null });
				if (!result.affected) return false;
				await this.audit(manager, admin, input); return true;
			}));
		}
		if (input.kind === 'expansion') {
			if (!/^[a-zA-Z0-9]{1,32}:[a-zA-Z0-9]{1,32}$/.test(input.id)) return false;
			const [followerId, targetId] = input.id.split(':');
			return this.guard.runMany([followerId, targetId], () => this.db.transaction(async manager => {
				for (const localUserId of [followerId, targetId]) {
					if (!await manager.getRepository(MiGridspaceLink).existsBy({ localUserId, state: 'active', initiator: true, peerOrigin: peer.peerOrigin })) return false;
				}
				const result = await manager.getRepository(MiGridspaceFollowExpansion).createQueryBuilder().update().set({ retryAt: new Date() })
					.where('"followerId"=:followerId AND "targetId"=:targetId AND state=\'pending\' AND reason=\'FOLLOW_FAILED\' AND "retryAt">NOW()', { followerId, targetId }).execute();
				if (!result.affected) return false;
				await this.audit(manager, admin, input); return true;
			}));
		}
		if (!input.version || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.version)) return false;
		return this.db.transaction(async manager => {
			// Keep the queued version and attempt history. A concurrent delete has a
			// new version and must not be replaced by this stale admin view.
			const result = await manager.getRepository(MiGridspaceNoteDelivery).createQueryBuilder().update().set({ retryAt: new Date() })
				.where('"noteId"=:id AND version=:version AND "peerOrigin"=:peer AND attempts>0 AND "retryAt">NOW()', { id: input.id, version: input.version, peer: peer.peerOrigin }).execute();
			if (!result.affected) return false;
			await this.audit(manager, admin, input); return true;
		});
	}
}
