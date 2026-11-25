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
const MAX_VIEWER_SESSIONS = 32;
export type TimelineKnownReference = { source?: 'local' | 'peer'; seen: boolean };

/** One expiring hash owns a bounded page cache and one entry per encountered URI. */
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
 local excess = redis.call('ZCARD', viewer) - ${MAX_VIEWER_SESSIONS}
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
-- Renew activity on writes as well as reads, rather than ranking by creation.
redis.call('ZADD', viewer, now, sessionId)
redis.call('PEXPIRE', viewer, 7200000)
local existing = redis.call('HGET', session, field)
if operation == 'claim' and existing then return existing end
if operation == 'nx' and existing then return existing end
if operation == 'merge' and existing then
 local old = cjson.decode(existing); local proposed = cjson.decode(value)
 if old.session ~= proposed.session or old.mode ~= proposed.mode or old.revision ~= proposed.revision or old.expires ~= proposed.expires then
  return redis.error_reply('TIMELINE_CONTEXT')
 end
end
local function remember(owners, seen)
 local visited = {}
 for _, uri in ipairs(seen or {}) do visited[uri] = true end
 for uri, source in pairs(owners or {}) do
  local key = 'ref:' .. uri
  local prior = redis.call('HGET', session, key)
  local owner = source == 'local' and 'l' or 'p'
  if prior and string.sub(prior, 1, 1) ~= '?' and string.sub(prior, 1, 1) ~= owner then
   discard(); return false
  end
  if not prior then redis.call('HINCRBY', session, '_references', 1) end
  redis.call('HSET', session, key, owner .. ((visited[uri] or (prior and string.sub(prior, 2, 2) == '1')) and '1' or '0'))
  visited[uri] = nil
 end
 for uri in pairs(visited) do
  local key = 'ref:' .. uri
  local prior = redis.call('HGET', session, key)
  if not prior then redis.call('HINCRBY', session, '_references', 1) end
  redis.call('HSET', session, key, (prior and string.sub(prior, 1, 1) or '?') .. '1')
 end
 return true
end
-- Upgrade an existing session in place. Its issued references and cursors stay valid.
local base = redis.call('HGET', session, 'session')
if base then
 local old = cjson.decode(base)
 if old.merge and ((old.merge.owners and next(old.merge.owners)) or (old.merge.seen and next(old.merge.seen))) then
  if not remember(old.merge.owners, old.merge.seen) then return redis.error_reply('TIMELINE_OWNER_CHANGED') end
  old.merge.owners = {}; old.merge.seen = {}
  local compact = cjson.encode(old)
  redis.call('HINCRBY', session, '_bytes', string.len(compact) - string.len(base))
  redis.call('HSET', session, 'session', compact)
  if field == 'session' then existing = compact end
 end
end
local identities = cjson.decode(ARGV[9])
if not remember(identities.owners, identities.seen) then return redis.error_reply('TIMELINE_OWNER_CHANGED') end
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
  if next.options and next.options.pinnedOnly and a.pinRank and b.pinRank then
   if a.pinRank ~= b.pinRank then return a.pinRank < b.pinRank end
   return a.canonicalUri > b.canonicalUri
  end
  if a.sortAt ~= b.sortAt then
   if ascending then return greater(b.sortAt, a.sortAt) end
   return greater(a.sortAt, b.sortAt)
  end
  if next.options and next.options.channelOrigin then return a.canonicalUri > b.canonicalUri end
  if a.source ~= b.source then return a.source == 'local' end
  if ascending then return (a.sourceId or a.noteId or a.canonicalUri) < (b.sourceId or b.noteId or b.canonicalUri) end
  return (a.sourceId or a.noteId or a.canonicalUri) > (b.sourceId or b.noteId or b.canonicalUri)
 end
 if old.session ~= next.session or old.mode ~= next.mode or old.revision ~= next.revision or old.expires ~= next.expires then
  return redis.error_reply('TIMELINE_CONTEXT')
 end
 if greater(next.sequence, old.sequence) then old.sequence = next.sequence end
 if greater(next.placementSequence, old.placementSequence) then old.placementSequence = next.placementSequence end
 if greater(next.peerSequence, old.peerSequence) then old.peerSequence = next.peerSequence end
 if newer(next.windowHead, old.windowHead) then old.windowHead = next.windowHead end
 if next.nextPolicyCheckAt and next.nextPolicyCheckAt ~= cjson.null and (not old.nextPolicyCheckAt or old.nextPolicyCheckAt == cjson.null or next.nextPolicyCheckAt < old.nextPolicyCheckAt) then old.nextPolicyCheckAt = next.nextPolicyCheckAt end
 if old.merge and next.merge then
  old.merge.owners = {}; old.merge.seen = {}
  for _, source in ipairs({'local', 'peer','localPlacement','peerPlacement'}) do
   if old.merge[source] and next.merge[source] and (not old.merge[source].upper or old.merge[source].upper == cjson.null) then
    old.merge[source].upper = next.merge[source].upper
   end
  end
 end
 value = cjson.encode(old)
end
local bytes = tonumber(redis.call('HGET', session, '_bytes') or '0') - (existing and string.len(existing) or 0) + string.len(value)
local pageId = string.match(field, '^page:(.+)$') or string.match(field, '^result:(.+)$')
local order = redis.call('HGET', session, '_pageOrder')
local pages = order and cjson.decode(order) or {}
if not order then
 -- A one-time upgrade of the old page index; normal paging never scans URI fields.
 local legacy = {}
 for _, key in ipairs(redis.call('HKEYS', session)) do
  local id = string.match(key, '^known:(.+)$')
  if id then table.insert(legacy, {id=id, clock=tonumber(redis.call('HGET', session, key)) or 0}) end
 end
 table.sort(legacy, function(a, b) return a.clock < b.clock end)
 for _, page in ipairs(legacy) do table.insert(pages, page.id) end
end
if pageId and redis.call('HEXISTS', session, 'known:' .. pageId) == 0 then
 table.insert(pages, pageId)
 redis.call('HSET', session, 'known:' .. pageId, redis.call('HINCRBY', session, '_pageClock', 1))
end
local count = #pages
-- Keep the current and look-ahead pages, and evict only older replay checkpoints.
-- The URI index remains intact, so eviction cannot reintroduce old duplicates.
if bytes > 262144 or count > 8 then
 local kept = {}; local newest = pages[#pages]
 for _, id in ipairs(pages) do
  if (bytes > 262144 or count > 8) and id ~= pageId and id ~= newest and id ~= ARGV[10] then
   for _, prefix in ipairs({'page:', 'result:'}) do
    local key = prefix .. id
    bytes = bytes - string.len(redis.call('HGET', session, key) or '')
    redis.call('HDEL', session, key)
   end
   redis.call('HDEL', session, 'known:' .. id)
   count = count - 1
  else
   table.insert(kept, id)
  end
 end
 pages = kept
end
if bytes > 262144 or count > 8 then discard(); return redis.error_reply('TIMELINE_CAPACITY') end
redis.call('HSET', session, field, value, '_bytes', bytes, '_pages', count, '_expires', expires, '_pageOrder', cjson.encode(pages))
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
		let identities: { owners: Record<string, 'local' | 'peer'>; seen: string[] } = { owners: {}, seen: [] };
		let nextPageId = '';
		try {
			const value = JSON.parse(json);
			if (typeof value?.nextId === 'string') nextPageId = value.nextId;
			if (value?.merge) {
				identities = { owners: value.merge.owners ?? {}, seen: value.merge.seen ?? [] };
				value.merge.owners = {}; value.merge.seen = [];
				json = JSON.stringify(value);
			}
		} catch { /* Some standalone store callers use opaque strings. */ }
		if (Buffer.byteLength(json) > 256 * 1024 || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 7200000) throw new GridspaceLinkError('INVALID_CURSOR');
		const owner = viewerId ?? await this.redis.get(`${PREFIX}owner:${session}`);
		if (!owner) throw new GridspaceLinkError('INVALID_CURSOR');
		this.validate(owner);
		const stored = field === 'session' ? json : this.compress(json);
		try {
			const result = await this.redis.eval(STORE, 3, `${PREFIX}owner:${session}`, `${PREFIX}session:${session}`, `${PREFIX}viewer:${owner}`,
				operation, field, stored, Date.now(), expires, owner, session, `${this.redis.options.keyPrefix ?? ''}${PREFIX}`, JSON.stringify(identities), nextPageId) as string;
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
			for (const source of ['local', 'peer', 'localPlacement', 'peerPlacement']) {
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

	/** Content-free decisions are indexed once, never copied into every page. */
	public async getReferences(session: string, uris: string[]): Promise<Record<string, TimelineKnownReference>> {
		this.validate(session);
		if (!uris.length) return {};
		if (uris.length > 1000) throw new GridspaceLinkError('INVALID_REQUEST');
		const values = await this.redis.hmget(`${PREFIX}session:${session}`, ...uris.map(uri => `ref:${uri}`));
		const result: Record<string, TimelineKnownReference> = {};
		for (const [index, value] of values.entries()) if (value) result[uris[index]] = {
			...(value[0] === 'l' ? { source: 'local' as const } : value[0] === 'p' ? { source: 'peer' as const } : {}), seen: value[1] === '1',
		};
		// Rolling upgrades can read a session created before the first compact write.
		if (values.some(value => value === null)) {
			const raw = await this.redis.hget(`${PREFIX}session:${session}`, 'session');
			const legacy = raw ? JSON.parse(raw).merge : null;
			const seen = new Set<string>(Array.isArray(legacy?.seen) ? legacy.seen : []);
			if (legacy) for (const uri of uris) if (!result[uri] && (legacy.owners?.[uri] || seen.has(uri))) {
				result[uri] = { source: legacy.owners?.[uri], seen: seen.has(uri) };
			}
		}
		return result;
	}

	private async read(session: string, field: string): Promise<string | null> {
		return await this.redis.eval(`local owner = redis.call('GET', KEYS[1])
if not owner then return false end
local expires = tonumber(redis.call('HGET', KEYS[2], '_expires') or '0')
local ttl = math.min(expires - tonumber(ARGV[2]), 1800000)
if ttl <= 0 then redis.call('DEL', KEYS[1], KEYS[2]); return false end
redis.call('PEXPIRE', KEYS[1], ttl); redis.call('PEXPIRE', KEYS[2], ttl)
local viewer = ARGV[3] .. 'viewer:' .. owner
redis.call('ZADD', viewer, ARGV[2], ARGV[4]); redis.call('PEXPIRE', viewer, 7200000)
return redis.call('HGET', KEYS[2], ARGV[1])`, 2,
			`${PREFIX}owner:${session}`, `${PREFIX}session:${session}`, field, Date.now(), `${this.redis.options.keyPrefix ?? ''}${PREFIX}`, session) as string | null;
	}

	public async claimResult(session: string, id: string, json: string, expires: number): Promise<string> {
		this.validate(id);
		return this.write('claim', session, `result:${id}`, json, expires);
	}
}
