/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import * as Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig, type Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { openGridspaceSecret } from '../link-crypto.js';
import { resolveGridspaceConfig } from '../peer-protocol.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { GridspaceTimelineService } from './GridspaceTimelineService.js';
import { TimelineSessionStore } from './TimelineSessionStore.js';
import type { GridspacePrivateService } from '../GridspacePrivateService.js';
import type { TimelineLocalSource } from './TimelineLocalSource.js';
import type { TimelineReferenceService } from './TimelineReferenceService.js';
import type { GridspaceTimelineListSourceService } from './GridspaceTimelineListSourceService.js';
import type { TimelineFavoriteSource } from './TimelineFavoriteSource.js';
import type { TimelineItem, TimelineOptions, TimelinePosition, TimelineReference } from './timeline-protocol.js';

// Independent oracle: numeric source timestamps and canonical identity, rather
// than the merge helper or serialized checkpoints produced by the implementation.
const chronological = (a: TimelinePosition, b: TimelinePosition) => Number(BigInt(b.sortAt) - BigInt(a.sortAt));
const ref = (source: 'local' | 'peer', value: number, uri?: string): TimelineReference => ({
	source, noteId: `${source[0]}${String(value).padStart(8, '0')}`, sortAt: String(BigInt(value) * 1000n),
	canonicalUri: uri ?? `https://${source}.example/notes/${value}`, normalized: true, generation: 1,
});
const options: TimelineOptions = { kind: 'home' };
const viewer = { id: 'coordinator' } as MiLocalUser;
const prefix = `timeline-coordinator-test:${randomUUID()}:`;
const secret = 'GRIDSPACE_COORDINATOR_TEST_SECRET';
let previousSecret: string | undefined;
let redis: Redis.Redis;
beforeAll(() => {
	previousSecret = process.env[secret]; process.env[secret] = Buffer.alloc(32, 7).toString('base64');
	redis = new Redis.Redis({ ...loadConfig().redis, keyPrefix: prefix });
});
afterAll(async () => {
	const keys = await redis.keys(`${prefix}*`);
	if (keys.length) await redis.del(...keys.map(key => key.slice(prefix.length)));
	await redis.quit();
	if (previousSecret === undefined) delete process.env[secret]; else process.env[secret] = previousSecret;
});

function fixture(initialLocal: TimelineReference[], initialPeer: TimelineReference[] = []) {
	const rows = { local: [...initialLocal], peer: [...initialPeer] };
	const local = mockDeep<TimelineLocalSource>();
	const references = mockDeep<TimelineReferenceService>();
	const delegated = mockDeep<GridspacePrivateService>();
	const events: { sequence: string; kind: 'insert' | 'update'; noteId: string; canonicalUri: string }[] = [];
	const peerEvents: { sequence: string; reference: TimelineReference }[] = [];
	let generation = 1;
	const config = { url: 'https://local.example', gridspace: { enabled: true, communityId: 'test', peerUrl: 'https://peer.example', keyId: 'test', secretEnv: secret } } as Config;
	const sessions = new TimelineSessionStore(redis);
	const lists = mockDeep<GridspaceTimelineListSourceService>();
	lists.readPage.mockResolvedValue({ references: [], next: null, upper: null, ended: true });
	lists.ownerReferences.mockResolvedValue([]); lists.ownerCandidates.mockResolvedValue([]); lists.hydrate.mockResolvedValue([]);
	const favorites = mockDeep<TimelineFavoriteSource>();
	favorites.readPage.mockResolvedValue({ references: [], next: null, upper: null, ended: true });
	favorites.ownerReferences.mockResolvedValue([]); favorites.ownerCandidates.mockResolvedValue([]); favorites.hydrate.mockResolvedValue([]);
	const service = new GridspaceTimelineService(config, sessions, local, references, delegated, lists, favorites);
	const decode = (cursor: string) => JSON.parse(openGridspaceSecret(resolveGridspaceConfig(config.gridspace, config.url, process.env)!, cursor, `timeline-v1:${viewer.id}:unified:${JSON.stringify(options)}`));
	const decodeUpdates = (page: { session: string; revision: string; updatesCursor: string }) => JSON.parse(openGridspaceSecret(resolveGridspaceConfig(config.gridspace, config.url, process.env)!, page.updatesCursor, `timeline-updates:${viewer.id}:${page.session}:${page.revision}`));
	const subset = (source: 'local' | 'peer', position: { before?: TimelinePosition; upper?: TimelinePosition; untilAt?: number; fromAt?: number }, limit: number, ascending = false) => rows[source]
		.filter(row => (!position.before || (ascending ? BigInt(row.sortAt) > BigInt(position.before.sortAt) : BigInt(row.sortAt) < BigInt(position.before.sortAt))) && (!position.upper || (ascending ? BigInt(row.sortAt) >= BigInt(position.upper.sortAt) : BigInt(row.sortAt) <= BigInt(position.upper.sortAt))) && (position.untilAt == null || BigInt(row.sortAt) <= BigInt(position.untilAt) * 1000n) && (position.fromAt == null || BigInt(row.sortAt) >= BigInt(position.fromAt) * 1000n))
		.sort((a, b) => (ascending ? -1 : 1) * chronological(a, b)).slice(0, limit);
	local.read.mockImplementation(async (_user, _opts, position) => subset('local', position, position.limit));
	local.readPage.mockImplementation(async (_user, _opts, position) => {
		const candidates = subset('local', position, position.limit + 1); const batch = candidates.slice(0, position.limit);
		return { references: batch, next: candidates.length > position.limit ? batch.at(-1)! : null, upper: position.upper ?? batch[0] ?? null, ended: candidates.length <= position.limit };
	});
	local.ownerReferences.mockImplementation(async (_user, _opts, uris, upper) => {
		if (uris.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		return upper === null ? [] : rows.local.filter(row => uris.includes(row.canonicalUri) && (!upper || BigInt(row.sortAt) <= BigInt(upper.sortAt)));
	});
	local.ownerCandidates.mockImplementation(async (_user, _opts, uris) => rows.local.filter(row => uris.includes(row.canonicalUri)));
	local.hydrate.mockImplementation(async (_user, _opts, selected) => {
		if (selected.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		return selected.filter(row => rows.local.some(current => current.noteId === row.noteId && current.canonicalUri === row.canonicalUri)).map(reference => ({ reference, payload: { id: reference.noteId, uri: reference.canonicalUri, createdAt: new Date(Number(BigInt(reference.sortAt) / 1000n)).toISOString() }, validForMs: null, nextPolicyCheckAt: null })) as never;
	});
	local.hydrateSingle.mockImplementation(async (user, opts, reference) => local.hydrate(user, opts, [reference]));
	local.nextViewerPolicyCheck.mockResolvedValue(null);
	references.status.mockImplementation(async () => ({ generation, currentSequence: String(events.length) }));
	references.currentPosition.mockImplementation(async () => String(events.length));
	references.getMany.mockImplementation(async ids => rows.local.filter(row => ids.includes(row.noteId)));
	references.changes.mockImplementation(async (after, limit = 100) => {
		const batch = events.filter(event => Number(event.sequence) > Number(after));
		return { events: batch.slice(0, limit), cursor: batch.length > limit ? batch[limit - 1].sequence : String(events.length), resetRequired: false, hasMore: batch.length > limit } as never;
	});
	delegated.timeline.mockImplementation(async (_user, input) => {
		// The signed timeline route explicitly permits [] for a sequence-only probe.
		if (input.ids && input.ids.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		const candidates = subset('peer', input, 51, input.kind === 'clip' && input.order === 'oldest'); const batch = candidates.slice(0, 50);
		const selected = input.ids ? rows.peer.filter(row => input.ids!.includes(row.noteId)) : [];
		return { references: input.ids ? [] : batch, next: input.ids || candidates.length <= 50 ? null : batch.at(-1), upper: input.upper ?? batch[0] ?? null,
											sequence: String(peerEvents.length), generation: 1, changed: false, validForMs: 10000,
											newReferences: input.sequence ? peerEvents.filter(event => Number(event.sequence) > Number(input.sequence)).map(event => event.reference) : [],
											notes: selected.map(row => ({ id: row.noteId, uri: row.canonicalUri, text: `body:${row.noteId}`, origin: 'https://peer.example' })),
		} as never;
	});
	const add = (row: TimelineReference) => {
		rows[row.source].push(row);
		if (row.source === 'local') events.push({ sequence: String(events.length + 1), kind: 'insert', noteId: row.noteId, canonicalUri: row.canonicalUri });
		else peerEvents.push({ sequence: String(peerEvents.length + 1), reference: row });
	};
	const changes = (page: { session: string; revision: string; updatesCursor: string }, retained: TimelineItem[], phase: 'validate' | 'changes' = 'changes') => service.changes(viewer, { ...page, refs: retained.map(item => item.ref), phase });
	return { service, sessions, local, references, delegated, rows, add, changes, decode, decodeUpdates, advanceGeneration: () => { generation++; } };
}

describe('unified timeline coordinator with real Redis checkpoints', () => {
	test.each<TimelineOptions>([
		{ kind: 'channel', channelId: 'channel' }, { kind: 'antenna', antennaId: 'antenna' },
		{ kind: 'clip', clipId: 'clip' }, { kind: 'clip', clipId: 'clip', order: 'oldest' },
		{ kind: 'profile', userId: 'author' }, { kind: 'search', query: 'word' },
		{ kind: 'mentions' }, { kind: 'direct' }, { kind: 'favorites' },
	])('restores a signed $kind position after its anchor becomes unreadable ($order)', async query => {
		const f = fixture([], [100, 90, 80].map(n => ref('peer', n)));
		const first = await f.service.page(viewer, query, 1);
		f.rows.peer = f.rows.peer.filter(row => row.noteId !== first.items[0].payload.id);
		const restored = await f.service.page(viewer, query, 30, undefined, 'unified', first.items[0].key, {
			previousSession: first.session, previousRevision: first.revision, refs: [], anchorRef: first.items[0].ref,
		});
		expect(restored.complete).toBe(true);
		expect(restored.items.map(item => item.key)).toEqual([...f.rows.peer].sort((a, b) => (query.order === 'oldest' ? -1 : 1) * chronological(a, b)).map(row => row.canonicalUri));
		await expect(f.service.page(viewer, { ...query, withFiles: true }, 30, undefined, 'unified', first.items[0].key, {
			previousSession: first.session, previousRevision: first.revision, refs: [], anchorRef: first.items[0].ref,
		})).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
	});
	test('restores history from an authenticated position even after the anchor becomes unreadable', async () => {
		const f = fixture([100, 90, 80].map(n => ref('local', n)));
		const first = await f.service.page(viewer, options, 1);
		f.rows.local.shift();
		const restored = await f.service.page(viewer, options, 30, undefined, 'unified', first.items[0].key, {
			previousSession: first.session, previousRevision: first.revision, refs: [], anchorRef: first.items[0].ref,
		});
		expect(restored.items.map(item => item.key)).toEqual([90, 80].map(n => ref('local', n).canonicalUri));
	});
	test('rejects a history anchor belonging to another viewer or another canonical URI', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 1);
		const retained = { previousSession: first.session, previousRevision: first.revision, refs: [], anchorRef: first.items[0].ref };
		await expect(f.service.page({ id: 'other' } as MiLocalUser, options, 30, undefined, 'unified', first.items[0].key, retained)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
		await expect(f.service.page(viewer, options, 30, undefined, 'unified', ref('local', 90).canonicalUri, retained)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
	});
	test('reuses one freshly authorized peer batch when renewing a channel or home window', async () => {
		const f = fixture([], [ref('peer', 100), ref('peer', 90)]);
		const first = await f.service.page(viewer, options, 20);
		f.delegated.timeline.mockClear();
		const renewed = await f.changes(first, first.items);
		expect(f.delegated.timeline).toHaveBeenCalledOnce();
		expect(f.delegated.timeline.mock.calls[0][1]).toMatchObject({ ids: first.items.map(item => item.payload.id), candidates: expect.any(Array) });
		expect(renewed.items.map(item => item.key)).toEqual(first.items.map(item => item.key));
		f.rows.peer.pop();
		const revoked = await f.changes(renewed, first.items);
		expect(revoked.removed).toEqual([ref('peer', 90).canonicalUri]);
	});
	test('native local stream emits a reauthorized envelope without consuming the HTTP update cursor', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		f.add(ref('local', 110));
		const before = f.decodeUpdates(first).sequence;
		const event = await f.service.streamNote(viewer, first.session, first.revision, { source: 'local', noteId: ref('local', 110).noteId });
		expect(event).toMatchObject({ session: first.session, revision: first.revision, resetRequired: false, item: { key: ref('local', 110).canonicalUri, representation: 'normal' } });
		expect(JSON.parse((await f.sessions.getSession(first.session))!).sequence).toBe(before);
		const replay = await f.service.streamNote(viewer, first.session, first.revision, { source: 'local', noteId: ref('local', 110).noteId });
		expect(replay.item?.key).toBe(event.item?.key);
	});
	test('local stream packs once and still checks current ownership after hydration', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		const incoming = ref('local', 110); f.add(incoming);
		f.local.hydrate.mockClear(); f.local.ownerReferences.mockClear(); f.local.ownerCandidates.mockClear();
		const event = await f.service.streamNote(viewer, first.session, first.revision, { source: 'local', noteId: incoming.noteId });
		expect(event.item?.key).toBe(incoming.canonicalUri);
		expect(f.local.hydrate).toHaveBeenCalledOnce();
		expect(f.local.ownerReferences).not.toHaveBeenCalled();
		expect(f.local.hydrateSingle).toHaveBeenCalledOnce();
		expect(f.local.ownerCandidates).toHaveBeenCalledOnce();
	});
	test('a root revoked after hydration is not emitted', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		const incoming = ref('local', 110); f.add(incoming);
		f.local.ownerCandidates.mockResolvedValueOnce([]);
		const event = await f.service.streamNote(viewer, first.session, first.revision, { source: 'local', noteId: incoming.noteId });
		expect(event).toMatchObject({ resetRequired: true });
		expect(event.item).toBeUndefined();
	});
	test('a local import arriving after peer hydration triggers a reset without duplicate output', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		const incoming = ref('peer', 110); f.add(incoming);
		const original = f.delegated.timeline.getMockImplementation()!;
		f.delegated.timeline.mockImplementation(async (...args) => ({ ...await original(...args), references: [incoming] }));
		f.local.ownerCandidates.mockResolvedValue([ref('local', 110, incoming.canonicalUri)]);
		const event = await f.service.streamNote(viewer, first.session, first.revision, { source: 'peer', noteId: incoming.noteId });
		expect(event).toMatchObject({ resetRequired: true });
		expect(event.item).toBeUndefined();
	});
	test('a peer grant revoked during ownership resolution is checked again before sending', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		const incoming = ref('peer', 110); f.add(incoming);
		const original = f.delegated.timeline.getMockImplementation()!;
		f.delegated.timeline.mockImplementation(async (...args) => ({ ...await original(...args), references: [incoming] }));
		f.local.ownerReferences.mockImplementationOnce(async () => {
			f.delegated.timeline.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
			return [];
		});
		await expect(f.service.streamNote(viewer, first.session, first.revision, { source: 'peer', noteId: incoming.noteId })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('native stream rejects foreign viewers, revoked bodies and late unknown arrivals', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		f.add(ref('local', 90));
		expect(await f.service.streamNote(viewer, first.session, first.revision, { source: 'local', noteId: ref('local', 90).noteId })).toMatchObject({ resetRequired: true });
		expect(await f.service.streamNote({ id: 'other' } as MiLocalUser, first.session, first.revision, { source: 'local', noteId: ref('local', 100).noteId })).toMatchObject({ resetRequired: true });
		f.rows.local.splice(0);
		expect((await f.service.streamNote(viewer, first.session, first.revision, { source: 'local', noteId: ref('local', 100).noteId })).item).toBeUndefined();
	});
	test('a private peer hint emits delegated content only after the peer authorizes it', async () => {
		const f = fixture([ref('local', 100)]);
		const first = await f.service.page(viewer, options, 20);
		const incoming = ref('peer', 110); f.add(incoming);
		const original = f.delegated.timeline.getMockImplementation()!;
		f.delegated.timeline.mockImplementation(async (...args) => ({ ...await original(...args), references: args[1].ids ? [incoming] : [] }));
		const event = await f.service.streamNote(viewer, first.session, first.revision, { source: 'peer', noteId: incoming.noteId });
		expect(event.item).toMatchObject({ key: incoming.canonicalUri, representation: 'delegated' });
		expect(event.item!.validForMs).toBeLessThanOrEqual(10000);
		f.delegated.timeline.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
		await expect(f.service.streamNote(viewer, first.session, first.revision, { source: 'peer', noteId: incoming.noteId })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('page, change, older, change keeps the newest window head and the complete retained order', async () => {
		const f = fixture([100, 90, 80, 70].map(n => ref('local', n)), [95, 85, 75].map(n => ref('peer', n)));
		const first = await f.service.page(viewer, options, 2);
		expect(first.items.map(item => item.key)).toEqual([ref('local', 100).canonicalUri, ref('peer', 95).canonicalUri]);
		f.add(ref('local', 110));
		const changed = await f.changes(first, first.items);
		expect(changed.newItems.map(item => item.key)).toEqual([ref('local', 110).canonicalUri]);
		const older = await f.service.page(viewer, options, 2, first.nextCursor!);
		expect(older.items.map(item => item.key)).toEqual([ref('local', 90).canonicalUri, ref('peer', 85).canonicalUri]);
		const retained = [...changed.newItems, ...first.items, ...older.items];
		f.add(ref('local', 105));
		const late = await f.changes(changed, retained);
		expect(late.resetRequired).toBe(true);
		expect(late.newItems).toEqual([]);
		expect(late.items.map(item => item.key)).toEqual(retained.map(item => item.key));
	});

	test('local ownership excludes a peer duplicate even when its timestamp is much newer', async () => {
		const canonical = 'https://original.example/notes/shared';
		const locals = Array.from({ length: 160 }, (_, i) => ref('local', 300 - i));
		locals.push(ref('local', 10, canonical));
		const peers = [ref('peer', 1000, canonical), ref('peer', 9)];
		const f = fixture(locals, peers);
		const emitted: TimelineItem[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 20; i++) {
			const page = await f.service.page(viewer, options, 20, cursor);
			expect(page.complete).toBe(true); emitted.push(...page.items);
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(emitted.map(item => item.key)).toEqual([...locals, peers[1]].sort(chronological).map(row => row.canonicalUri));
		expect(emitted.filter(item => item.key === canonical)).toHaveLength(1);
		expect(emitted.find(item => item.key === canonical)?.representation).toBe('normal');
	});

	test('parallel requests for the same cursor return identical selection and next cursor', async () => {
		const f = fixture([100, 90, 80].map(n => ref('local', n)), [95, 85, 75].map(n => ref('peer', n)));
		const first = await f.service.page(viewer, options, 1);
		const [a, b] = await Promise.all([f.service.page(viewer, options, 2, first.nextCursor!), f.service.page(viewer, options, 2, first.nextCursor!)]);
		expect(a.items.map(item => item.key)).toEqual([ref('peer', 95).canonicalUri, ref('local', 90).canonicalUri]);
		expect(a.items.map(item => item.key)).toEqual(b.items.map(item => item.key));
		// Encryption has a fresh nonce; the authenticated checkpoint identity is
		// what must remain unchanged, not the opaque ciphertext bytes.
		expect(f.decode(a.nextCursor!)).toEqual(f.decode(b.nextCursor!));
	});

	test('an empty private source preserves local paging and later detects its first private arrival', async () => {
		const f = fixture([100, 90, 80].map(n => ref('local', n)));
		const first = await f.service.page(viewer, options, 2);
		expect(first.complete).toBe(true);
		f.add(ref('peer', 120));
		const changed = await f.changes(first, first.items);
		expect(changed.newItems.map(item => item.key)).toEqual([ref('peer', 120).canonicalUri]);
		const older = await f.service.page(viewer, options, 2, first.nextCursor!);
		expect(older.items.map(item => item.key)).toEqual([ref('local', 80).canonicalUri]);
	});

	test('a retained window larger than 100 rows keeps its global head when only a later batch validates', async () => {
		const f = fixture(Array.from({ length: 140 }, (_, i) => ref('local', 300 - i)));
		const pages = []; let cursor: string | undefined;
		for (let i = 0; i < 4; i++) { const page = await f.service.page(viewer, options, 40, cursor); pages.push(page); cursor = page.nextCursor ?? undefined; }
		const first = pages[0]; const retained = pages.flatMap(page => page.items);
		expect(retained).toHaveLength(140);
		await f.changes(first, retained.slice(100), 'validate');
		f.add(ref('local', 250));
		const late = await f.changes(first, retained.slice(100));
		expect(late.resetRequired).toBe(true);
		expect(late.newItems).toEqual([]);
	});

	test('backfill generation change rejects the old cursor instead of mixing index generations', async () => {
		const f = fixture([100, 90, 80].map(n => ref('local', n)));
		const first = await f.service.page(viewer, options, 1);
		f.advanceGeneration();
		await expect(f.service.page(viewer, options, 1, first.nextCursor!)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
		const changed = await f.changes(first, first.items);
		expect(changed.resetRequired).toBe(true);
	});

	test('a delayed older-page commit cannot roll back a simultaneous live head or event cursor', async () => {
		const f = fixture([100, 90, 80, 70].map(n => ref('local', n)));
		const first = await f.service.page(viewer, options, 1);
		let unlock!: () => void; let reached!: () => void;
		const waiting = new Promise<void>(resolve => { reached = resolve; });
		const gate = new Promise<void>(resolve => { unlock = resolve; });
		const originalClaim = f.sessions.claimResult.bind(f.sessions);
		f.sessions.claimResult = async (...args) => { reached(); await gate; return originalClaim(...args); };
		const olderRequest = f.service.page(viewer, options, 1, first.nextCursor!);
		await waiting;
		f.add(ref('local', 110));
		const live = await f.changes(first, first.items);
		expect(live.newItems.map(item => item.key)).toEqual([ref('local', 110).canonicalUri]);
		unlock(); const older = await olderRequest;
		expect(older.items.map(item => item.key)).toEqual([ref('local', 90).canonicalUri]);
		const state = JSON.parse((await f.sessions.getSession(first.session))!);
		expect(state.sequence).toBe('1'); expect(state.windowHead.canonicalUri).toBe(ref('local', 110).canonicalUri);
		f.add(ref('local', 105));
		const late = await f.changes(live, [...live.newItems, ...first.items, ...older.items]);
		expect(late.resetRequired).toBe(true); expect(late.newItems).toEqual([]);
	});

	test('two late live responses preserve the greatest sequence and newest head in actual Lua', async () => {
		const f = fixture([100, 90].map(n => ref('local', n)));
		const first = await f.service.page(viewer, options, 1);
		const originalHydrate = f.local.hydrate.getMockImplementation()!;
		let unlock!: () => void; let reached!: () => void; let held = false;
		const waiting = new Promise<void>(resolve => { reached = resolve; });
		const gate = new Promise<void>(resolve => { unlock = resolve; });
		f.local.hydrate.mockImplementation(async (...args) => {
			const value = await originalHydrate(...args);
			if (!held && args[2].some(row => row.noteId === ref('local', 110).noteId)) { held = true; reached(); await gate; }
			return value;
		});
		f.add(ref('local', 110)); const slower = f.changes(first, first.items); await waiting;
		f.add(ref('local', 120)); const faster = await f.changes(first, first.items);
		expect(faster.newItems.map(item => item.key)).toEqual([ref('local', 120).canonicalUri, ref('local', 110).canonicalUri]);
		unlock(); const slowResult = await slower;
		expect(f.decodeUpdates(slowResult).sequence).toBe('1');
		expect(f.decodeUpdates(faster).sequence).toBe('2');
		const state = JSON.parse((await f.sessions.getSession(first.session))!);
		expect(state.sequence).toBe('2'); expect(state.windowHead.canonicalUri).toBe(ref('local', 120).canonicalUri);
	});

	test('a full first peer batch pages into its next fifty without dropping or repeating rows', async () => {
		const peers = Array.from({ length: 125 }, (_, i) => ref('peer', 300 - i));
		const f = fixture([], peers); const emitted: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 8; i++) {
			const page = await f.service.page(viewer, options, 20, cursor);
			expect(page.complete).toBe(true); emitted.push(...page.items.map(item => item.key));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(emitted).toEqual(peers.map(row => row.canonicalUri));
		expect(f.delegated.timeline.mock.calls.some(([, input]) => input.before?.noteId === peers[49].noteId)).toBe(true);
	});

	test('cursor continuation inspects a mutation behind five hundred unrelated events in bounded batches', async () => {
		const f = fixture([100, 90, 80].map(n => ref('local', n)));
		const first = await f.service.page(viewer, options, 1);
		const reads: string[] = [];
		const backlog = Array.from({ length: 500 }, (_, i) => ({ sequence: String(i + 1), kind: 'insert', noteId: `other${i}`, canonicalUri: `https://other/${i}` }));
		backlog.push({ sequence: '501', kind: 'update', noteId: ref('local', 90).noteId, canonicalUri: ref('local', 90).canonicalUri });
		f.references.changes.mockImplementation(async (after, limit = 100) => {
			reads.push(after);
			const eligible = backlog.filter(event => Number(event.sequence) > Number(after));
			const batch = eligible.slice(0, limit);
			return { events: batch, cursor: batch.at(-1)?.sequence ?? '501', resetRequired: false, hasMore: eligible.length > limit } as never;
		});
		await expect(f.service.page(viewer, options, 1, first.nextCursor!)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
		expect(reads).toEqual(['0', '100', '200', '300', '400', '500']);
	});

	test('more than twenty ordinary pages remain usable within the aggregate Redis budget', async () => {
		const input = Array.from({ length: 520 }, (_, i) => ref('local', 1000 - i, `https://source.example/users/${'a'.repeat(75)}/notes/${String(1000 - i).padStart(20, '0')}`));
		const f = fixture(input);
		const seen: string[] = []; let cursor: string | undefined; let pages = 0;
		for (; pages < 30; pages++) {
			const page = await f.service.page(viewer, options, 20, cursor);
			expect(page.complete, `page ${pages + 1} must fit the bounded session`).toBe(true);
			seen.push(...page.items.map(item => item.key));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(pages + 1).toBe(26);
		expect(seen).toEqual(input.map(row => row.canonicalUri));
	});

	test('equal timestamp and short ID on distinct sources remain distinct in page order', async () => {
		const first = { ...ref('local', 100), noteId: 'same000000' };
		const second = { ...ref('peer', 100), noteId: 'same000000' };
		const f = fixture([first], [second]);
		const page = await f.service.page(viewer, options, 1);
		const next = await f.service.page(viewer, options, 1, page.nextCursor!);
		expect(page.items[0].key).toBe(first.canonicalUri);
		expect(next.items[0].key).toBe(second.canonicalUri);
	});
});
