/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Run on the application host: docker compose exec -T web node scripts/inspect-slow-requests.mjs
import { createRequire } from 'node:module';
import { loadConfig } from '../packages/backend/built/config.js';

const require = createRequire(new URL('../packages/backend/package.json', import.meta.url));
const { Redis } = require('ioredis');
const args = process.argv.slice(2);
const minMs = Number(args.find(arg => arg.startsWith('--min-ms='))?.split('=')[1] ?? 1000);
const route = args.find(arg => arg.startsWith('--route='))?.slice('--route='.length) ?? '';
if (!Number.isFinite(minMs) || minMs < 1000) throw new Error('--min-ms must be at least 1000');
const redis = new Redis({ ...loadConfig().redis, maxRetriesPerRequest: 1, lazyConnect: true });
try {
	await redis.connect();
	const now = Date.now();
	const key = 'slow-api-requests:v1';
	await redis.zremrangebyscore(key, '-inf', now - 86400000);
	const requests = (await redis.zrevrange(key, 0, 499)).flatMap(row => {
		try { return [JSON.parse(row)]; } catch { return []; }
	}).filter(row => row.durationMs >= minMs && row.route.includes(route));
	const groups = new Map();
	for (const row of requests) {
		const group = groups.get(row.route) ?? { route: row.route, count: 0, totalMs: 0, maxMs: 0, peerTotalMs: 0, failures: 0 };
		group.count++;
		group.totalMs += row.durationMs;
		group.maxMs = Math.max(group.maxMs, row.durationMs);
		group.peerTotalMs += row.peers.reduce((sum, peer) => sum + peer.durationMs, 0);
		group.failures += Number(row.statusCode >= 400);
		groups.set(row.route, group);
	}
	console.log(JSON.stringify({ capturedAt: new Date(now).toISOString(), sample: 'Slow requests only; last 24 hours, at most 500 entries; overload may drop records.',
		byRoute: [...groups.values()].sort((a, b) => b.maxMs - a.maxMs), requests }, null, 2));
} finally {
	redis.disconnect();
}
