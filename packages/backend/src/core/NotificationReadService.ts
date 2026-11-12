/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';

// All changes and the resulting count share one Redis snapshot. Stream IDs have
// uint64 sequence numbers: compare decimal strings, never Lua floating points.
export const notificationReadScript = `
local function less(a, b)
 local am, as = string.match(a, '^(%d+)%-(%d+)$')
 local bm, bs = string.match(b, '^(%d+)%-(%d+)$')
 if am ~= bm then return #am < #bm or (#am == #bm and am < bm) end
 return #as < #bs or (#as == #bs and as < bs)
end
local mark = redis.call('GET', KEYS[2])
if ARGV[1] == 'all' then
 local head = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
 if #head > 0 then mark = head[1][1]; redis.call('SET', KEYS[2], mark) end
 redis.call('DEL', KEYS[3])
elseif ARGV[1] == 'read' then
 for i = 2, #ARGV do
  if (not mark or less(mark, ARGV[i])) and #redis.call('XRANGE', KEYS[1], ARGV[i], ARGV[i]) > 0 then
   redis.call('SADD', KEYS[3], ARGV[i])
  end
 end
end
local oldest = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1)
for _, id in ipairs(redis.call('SMEMBERS', KEYS[3])) do
 if #oldest == 0 or less(id, oldest[1][1]) or (mark and not less(mark, id)) then redis.call('SREM', KEYS[3], id) end
end
local count = 0
for _, row in ipairs(redis.call('XRANGE', KEYS[1], mark and ('(' .. mark) or '-', '+')) do
 if redis.call('SISMEMBER', KEYS[3], row[1]) == 0 then count = count + 1 end
end
local result = {count}
for i = 2, #ARGV do
 table.insert(result, (mark and not less(mark, ARGV[i])) and 1 or redis.call('SISMEMBER', KEYS[3], ARGV[i]))
end
return result
`;

@Injectable()
export class NotificationReadService {
	constructor(@Inject(DI.redis) private redis: Redis.Redis, private ids: IdService) {}

	public async state(userId: string, ids: string[] = [], action: 'status' | 'read' | 'all' = 'status') {
		const streamIds = ids.map(id => {
			const parsed = this.ids.parseFull(id);
			return `${parsed.date}-${BigInt.asUintN(64, parsed.additional)}`;
		});
		const result = await this.redis.eval(notificationReadScript, 3, `notificationTimeline:${userId}`, `latestReadNotification:${userId}`, `readNotifications:${userId}`, action, ...streamIds) as number[];
		return { unreadCount: result[0], isRead: result.slice(1).map(value => value === 1) };
	}
}
