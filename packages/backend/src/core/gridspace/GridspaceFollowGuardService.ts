/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import pg from 'pg';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiGridspaceFollowOverride } from '@/models/Gridspace.js';

@Injectable()
export class GridspaceFollowGuardService implements OnApplicationShutdown {
	private locks: pg.Pool | null;
	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config) {
		// Lock waiters must never occupy the pool used by the operations holding those locks.
		this.locks = config.gridspace?.enabled ? new pg.Pool({ host: config.db.host, port: config.db.port,
			user: config.db.user, password: config.db.pass, database: config.db.db, ...config.db.extra, max: 2 }) : null;
	}

	public async onApplicationShutdown(): Promise<void> { await this.locks?.end(); }

	/** A session lock also covers side effects committed by the ordinary following service. */
	public async run<T>(localUserId: string, action: () => Promise<T>, cancelledTarget?: string): Promise<T> {
		if (!this.locks) return action();
		const connection = await this.locks.connect();
		const lock = `gridspace-follow:${localUserId}`;
		try {
			await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
			if (cancelledTarget) {
				// Commit before unfollowing: a crash cannot erase the user's cancellation.
				await this.db.getRepository(MiGridspaceFollowOverride).upsert({ localUserId, targetUserId: cancelledTarget, changedAt: new Date() }, ['localUserId', 'targetUserId']);
			}
			return await action();
		} finally {
			try { await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]); } finally { connection.release(); }
		}
	}
}
