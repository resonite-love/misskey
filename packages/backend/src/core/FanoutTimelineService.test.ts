/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { expect, test } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { loadConfig } from '@/config.js';
import type { IdService } from './IdService.js';
import { FanoutTimelineService } from './FanoutTimelineService.js';

test('merges historical replies into a warm list without evicting newer roots or concurrent writes', async () => {
	const redis = new Redis(loadConfig().redisForTimelines);
	const writer = redis.duplicate();
	const service = new FanoutTimelineService(redis, mock<IdService>());
	const channelId = randomUUID();
	const key = 'list:channelTimeline:' + channelId;
	try {
		await service.mergeChannelReplies(channelId, ['04'], 4);
		expect(await redis.exists(key)).toBe(0);
		await redis.rpush(key, '09', '05', '09', '03');
		await service.mergeChannelReplies(channelId, ['02', '04', '08', '04'], 4);
		expect(await redis.lrange(key, 0, -1)).toEqual(['09', '08', '05', '04']);
		await Promise.all([writer.lpush(key, '10'), service.mergeChannelReplies(channelId, ['07', '01'], 4)]);
		await service.mergeChannelReplies(channelId, ['07'], 4);
		expect(await redis.lrange(key, 0, -1)).toEqual(['10', '09', '08', '07']);
	} finally {
		await redis.del(key);
		await Promise.all([redis.quit(), writer.quit()]);
	}
});
