/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';

const PREFIX = 'gridspace:timeline-store:';

/** One hash contains the session and all its checkpoints so eviction is atomic. */
const STORE = `
local current = redis.call('GET', KEYS[1])
local session = KEYS[2]
local viewer = KEYS[3]
local operation = ARGV[1]
local field = ARGV[2]
local value = ARGV[3]
local now = tonumber(ARGV[4])
local expires = tonumber(ARGV[5])
local ttl = math.min(expires - now, 1800000)
local owner = ARGV[6]
local sessionId = ARGV[7]
local function discard()
 redis.call('DEL', session, KEYS[1])
 redis.call('ZREM', viewer, sessionId)
end
if ttl <= 0 then return redis.error_reply('TIMELINE_EXPIRED') end
if operation == 'start' then
 local previous = redis.call('ZRANGE', viewer, 0, -1)
 for _, id in ipairs(previous) do
  if redis.call('EXISTS', ARGV[8] .. 'owner:' .. id) == 0 then
   redis.call('DEL', ARGV[8] .. 'session:' .. id)
   redis.call('ZREM', viewer, id)
  end
 end
 if current and current ~= owner then return redis.error_reply('TIMELINE_OWNER') end
 redis.call('SET', KEYS[1], owner, 'PX', ttl)
 redis.call('ZADD', viewer, now, sessionId)
 redis.call('PEXPIRE', viewer, 7200000)
 local excess = redis.call('ZCARD', viewer) - 8
 if excess > 0 then
  local oldest = redis.call('ZRANGE', viewer, 0, excess - 1)
  for _, id in ipairs(oldest) do
   redis.call('DEL', ARGV[8] .. 'session:' .. id, ARGV[8] .. 'owner:' .. id)
   redis.call('ZREM', viewer, id)
  end
 end
 if redis.call('EXISTS', KEYS[1]) == 0 then return redis.error_reply('TIMELINE_EXPIRED') end
elseif not current or current ~= owner or redis.call('EXISTS', session) == 0 then
 return redis.error_reply('TIMELINE_EXPIRED')
end
local existing = redis.call('HGET', session, field)
if operation == 'claim' and existing then return existing end
if operation == 'nx' and existing then return existing end
if operation == 'merge' and existing then
 local old = cjson.decode(existing)
 local next = cjson.decode(value)
 local function greater(a, b)
  if not a or a == cjson.null then return false end
  if not b or b == cjson.null then return true end
  a = tostring(a); b = tostring(b)
  return string.len(a) > string.len(b) or (string.len(a) == string.len(b) and a > b)
 end
 local function newer(a, b)
  if not a or a == cjson.null then return false end
  if not b or b == cjson.null then return true end
  local ascending = next.options and next.options.kind == 'clip' and next.options.order == 'oldest'
  if a.sortAt ~= b.sortAt then
   if ascending then return greater(b.sortAt, a.sortAt) end
   return greater(a.sortAt, b.sortAt)
  end
  if a.source ~= b.source then return a.source == 'local' end
  if ascending then return (a.sourceId or a.noteId or a.canonicalUri) < (b.sourceId or b.noteId or b.canonicalUri) end
  return (a.sourceId or a.noteId or a.canonicalUri) > (b.sourceId or b.noteId or b.canonicalUri)
 end
 if old.session ~= next.session or old.mode ~= next.mode or old.revision ~= next.revision or old.expires ~= next.expires then
  return redis.error_reply('TIMELINE_CONTEXT')
 end
 if greater(next.sequence, old.sequence) then old.sequence = next.sequence end
 if greater(next.peerSequence, old.peerSequence) then old.peerSequence = next.peerSequence end
 if newer(next.windowHead, old.windowHead) then old.windowHead = next.windowHead end
 if next.nextPolicyCheckAt and next.nextPolicyCheckAt ~= cjson.null and (not old.nextPolicyCheckAt or old.nextPolicyCheckAt == cjson.null or next.nextPolicyCheckAt < old.nextPolicyCheckAt) then old.nextPolicyCheckAt = next.nextPolicyCheckAt end
 if old.merge and next.merge then
  old.merge.owners = old.merge.owners or {}
  for uri, source in pairs(next.merge.owners or {}) do
   if old.merge.owners[uri] and old.merge.owners[uri] ~= source then discard(); return redis.error_reply('TIMELINE_OWNER_CHANGED') end
   old.merge.owners[uri] = source
  end
  local seen = {}; local values = {}
  for _, uri in ipairs(old.merge.seen or {}) do if not seen[uri] then seen[uri] = true; table.insert(values, uri) end end
  for _, uri in ipairs(next.merge.seen or {}) do if not seen[uri] then seen[uri] = true; table.insert(values, uri) end end
  local count = 0; for _ in pairs(old.merge.owners) do count = count + 1 end
  if count > 2000 or #values > 2000 then discard(); return redis.error_reply('TIMELINE_CAPACITY') end
  if #values > 0 then old.merge.seen = values end
  for _, source in ipairs({'local', 'peer'}) do
   if old.merge[source] and next.merge[source] and (not old.merge[source].upper or old.merge[source].upper == cjson.null) then
    old.merge[source].upper = next.merge[source].upper
   end
  end
 end
 value = cjson.encode(old)
end
local bytes = tonumber(redis.call('HGET', session, '_bytes') or '0') - (existing and string.len(existing) or 0) + string.len(value)
local pageId = string.match(field, '^page:(.+)$') or string.match(field, '^result:(.+)$')
local count = tonumber(redis.call('HGET', session, '_pages') or '0')
if pageId and redis.call('HEXISTS', session, 'known:' .. pageId) == 0 then count = count + 1 end
if bytes > 262144 or count > 64 then discard(); return redis.error_reply('TIMELINE_CAPACITY') end
redis.call('HSET', session, field, value, '_bytes', bytes, '_pages', count, '_expires', expires)
if pageId then redis.call('HSET', session, 'known:' .. pageId, '1') end
redis.call('PEXPIRE', session, ttl)
redis.call('PEXPIRE', KEYS[1], ttl)
return value
`;

@Injectable()
export class TimelineSessionStore {
	constructor(@Inject(DI.redis) private readonly redis: Redis.Redis) {}

	private validate(id: string): void {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new GridspaceLinkError('INVALID_CURSOR');
	}

	private async write(operation: string, session: string, field: string, json: string, expires: number, viewerId?: string): Promise<string> {
		this.validate(session);
		if (Buffer.byteLength(json) > 256 * 1024 || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 7200000) throw new GridspaceLinkError('INVALID_CURSOR');
		const owner = viewerId ?? await this.redis.get(`${PREFIX}owner:${session}`);
		if (!owner) throw new GridspaceLinkError('INVALID_CURSOR');
		this.validate(owner);
		const stored = field === 'session' ? json : this.compress(json);
		try {
			const result = await this.redis.eval(STORE, 3, `${PREFIX}owner:${session}`, `${PREFIX}session:${session}`, `${PREFIX}viewer:${owner}`,
				operation, field, stored, Date.now(), expires, owner, session, `${this.redis.options.keyPrefix ?? ''}${PREFIX}`) as string;
			return field === 'session' ? result : this.decompress(result);
		} catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
	}

	private compress(json: string): string {
		const compressed = `z:${deflateRawSync(Buffer.from(json)).toString('base64')}`;
		return Buffer.byteLength(compressed) < Buffer.byteLength(json) ? compressed : json;
	}

	private decompress(value: string): string {
		return value.startsWith('z:') ? inflateRawSync(Buffer.from(value.slice(2), 'base64'), { maxOutputLength: 256 * 1024 }).toString() : value;
	}

	public async start(viewerId: string, session: string, json: string, expires: number): Promise<void> {
		await this.write('start', session, 'session', json, expires, viewerId);
	}

	public async putSession(session: string, json: string, expires: number): Promise<string> {
		return this.normalizeSession(await this.write('merge', session, 'session', json, expires));
	}

	public async getSession(session: string): Promise<string | null> {
		this.validate(session);
		const value = await this.read(session, 'session');
		return value == null ? null : this.normalizeSession(value);
	}

	private normalizeSession(json: string): string {
		// Redis Lua cjson encodes an empty array as {}. Normalize only the known
		// collection fields; ownership maps must remain objects.
		const value = JSON.parse(json);
		for (const field of ['selected']) if (value[field] != null && !Array.isArray(value[field])) value[field] = [];
		if (value.merge) {
			if (!Array.isArray(value.merge.seen)) value.merge.seen = [];
			for (const source of ['local', 'peer']) {
				if (value.merge[source]?.pending != null && !Array.isArray(value.merge[source].pending)) value.merge[source].pending = [];
			}
		}
		return JSON.stringify(value);
	}

	public async putCheckpoint(session: string, id: string, json: string, expires: number, onlyAbsent = false): Promise<void> {
		this.validate(id);
		await this.write(onlyAbsent ? 'nx' : 'put', session, `page:${id}`, json, expires);
	}

	public async getCheckpoint(session: string, id: string): Promise<string | null> {
		this.validate(session); this.validate(id);
		const value = await this.read(session, `page:${id}`);
		return value == null ? null : this.decompress(value);
	}

	private async read(session: string, field: string): Promise<string | null> {
		return await this.redis.eval(`if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local expires = tonumber(redis.call('HGET', KEYS[2], '_expires') or '0')
local ttl = math.min(expires - tonumber(ARGV[2]), 1800000)
if ttl <= 0 then redis.call('DEL', KEYS[1], KEYS[2]); return false end
redis.call('PEXPIRE', KEYS[1], ttl); redis.call('PEXPIRE', KEYS[2], ttl)
return redis.call('HGET', KEYS[2], ARGV[1])`, 2,
			`${PREFIX}owner:${session}`, `${PREFIX}session:${session}`, field, Date.now()) as string | null;
	}

	public async claimResult(session: string, id: string, json: string, expires: number): Promise<string> {
		this.validate(id);
		return this.write('claim', session, `result:${id}`, json, expires);
	}
}
