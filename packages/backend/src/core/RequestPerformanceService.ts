/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { SlowRequestRecord } from '@/misc/request-performance.js';
import type Logger from '@/logger.js';
import { LoggerService } from './LoggerService.js';

const KEY = 'slow-api-requests:v1';
export const SLOW_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SLOW_REQUEST_LIMIT = 500;

@Injectable()
export class RequestPerformanceService {
	private pending = 0;
	private logger: Logger;

	constructor(@Inject(DI.redis) private redis: Redis.Redis, loggerService: LoggerService) {
		this.logger = loggerService.getLogger('performance');
	}

	public record(entry: SlowRequestRecord): void {
		// Diagnostics must never become a request bottleneck during an outage.
		if (this.pending >= 8) return;
		this.pending++;
		this.logger.write({ level: 'warn', eventName: 'api.request.slow', message: `Slow API ${entry.route}: ${entry.durationMs}ms`, attributes: {
			'request.id': entry.id, 'http.route': entry.route, 'http.status_code': entry.statusCode, 'duration_ms': entry.durationMs,
			'peer.duration_ms': entry.peers.reduce((sum, peer) => sum + peer.durationMs, 0),
		} });
		void this.redis.multi().zadd(KEY, Date.parse(entry.createdAt), JSON.stringify(entry))
			.zremrangebyscore(KEY, '-inf', Date.now() - SLOW_REQUEST_RETENTION_MS)
			.zremrangebyrank(KEY, 0, -SLOW_REQUEST_LIMIT - 1).expire(KEY, 86400).exec()
			.catch(() => { /* Keep serving requests if diagnostic storage is unavailable. */ })
			.finally(() => { this.pending--; });
	}

	public async recent(): Promise<SlowRequestRecord[]> {
		const since = Date.now() - SLOW_REQUEST_RETENTION_MS;
		await this.redis.zremrangebyscore(KEY, '-inf', since);
		const rows = await this.redis.zrevrange(KEY, 0, SLOW_REQUEST_LIMIT - 1);
		return rows.flatMap(row => {
			try {
				const entry = JSON.parse(row) as SlowRequestRecord;
				return Date.parse(entry.createdAt) >= since ? [entry] : [];
			} catch { return []; }
		}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}
