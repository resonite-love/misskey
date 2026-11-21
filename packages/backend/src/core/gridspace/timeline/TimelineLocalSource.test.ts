/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DataSource, type QueryRunner, type SelectQueryBuilder } from 'typeorm';
import { loadConfig } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import type { QueryService } from '@/core/QueryService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { IdService } from '@/core/IdService.js';
import type { Config } from '@/config.js';
import { TimelineLocalSource, timelinePolicyDeadline } from './TimelineLocalSource.js';
import type { GridspaceIdentityService } from '../GridspaceIdentityService.js';
import type { GridspaceSearchService } from '../GridspaceSearchService.js';
import type { TimelineReference } from './timeline-protocol.js';

const now = Date.UTC(2026, 10, 17, 1);
const viewer = { id: 'viewer' } as MiLocalUser;
const reference = (id: string): TimelineReference => ({ noteId: id, canonicalUri: `https://example.test/notes/${id}`, sortAt: String(now * 1000), normalized: true, generation: 1, source: 'local' });
const user = { id: 'author', makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: null, isDeleted: false, isSuspended: false };
const row = (id: string): MiNote => ({ id, uri: null, userId: 'author', user, visibility: 'public', text: id, cw: null, visibleUserIds: [], fileIds: [], replyId: null, renoteId: null, hasPoll: false } as unknown as MiNote);
const payload = (id: string): Packed<'Note'> => ({ id, userId: 'author', user, createdAt: new Date(now).toISOString(), visibility: 'public', text: id, cw: null, fileIds: [], replyId: null, renoteId: null } as unknown as Packed<'Note'>);

function query(rows: MiNote[]): SelectQueryBuilder<MiNote> {
	const builder = { andWhere: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValue(rows) };
	return builder as unknown as SelectQueryBuilder<MiNote>;
}

function fixture(options: { before?: MiNote[]; fresh?: MiNote[]; related?: MiNote[]; packed?: Packed<'Note'>[]; deadline?: Date | null } = {}) {
	const before = options.before ?? [row('a')];
	const fresh = options.fresh ?? before;
	const queries = [query(before), query(fresh)];
	const queryFactory = vi.fn(async () => queries.shift()!);
	const notes = { packMany: vi.fn().mockResolvedValue(options.packed ?? before.map(note => payload(note.id))) };
	const search = { noteQuery: vi.fn(() => query(options.related ?? fresh)) };
	const db = { query: vi.fn().mockResolvedValue([{ deadline: options.deadline ?? null }]) };
	const ids = { parse: vi.fn(() => ({ date: new Date(now) })) };
	const source = new TimelineLocalSource(db as unknown as DataSource, { url: 'https://example.test' } as Config, search as unknown as GridspaceSearchService,
		{} as QueryService, {} as GridspaceIdentityService, {} as RoleService, notes as unknown as NoteEntityService, ids as unknown as IdService);
	return { source, queryFactory, notes, search };
}

describe('local timeline body authorization', () => {
	test('single-note hydration selects only authorization fields after packing and skips absent nested targets', async () => {
		const { source, queryFactory, notes, search } = fixture();
		expect((await source.hydrateQuery(viewer, queryFactory, [reference('a')], true)).map(item => item.payload.id)).toEqual(['a']);
		expect(notes.packMany).toHaveBeenCalledOnce();
		expect(search.noteQuery).not.toHaveBeenCalled();
		expect(queryFactory).toHaveBeenCalledTimes(2);
	});
	test.each([
		{ fresh: [] },
		{ fresh: [{ ...row('a'), visibleUserIds: ['other'] }] },
		{ fresh: [{ ...row('a'), fileIds: ['new-file'] }] },
	])('single-note hydration rejects revocation or changed content after packing: %j', async options => {
		const { source, queryFactory } = fixture(options);
		expect(await source.hydrateQuery(viewer, queryFactory, [reference('a')], true)).toEqual([]);
	});
	test('single-note hydration still strips a revoked nested quote', async () => {
		const outer = { ...row('a'), renoteId: 'b' };
		const { source, queryFactory, search } = fixture({ before: [outer], fresh: [outer], related: [], packed: [{ ...payload('a'), renoteId: 'b', renote: payload('b') }] });
		const [result] = await source.hydrateQuery(viewer, queryFactory, [reference('a')], true);
		expect(result.payload.renote).toBeNull();
		expect(search.noteQuery).toHaveBeenCalledOnce();
	});
	test('ownership candidates check the root query without packing a body', async () => {
		const { source, notes } = fixture();
		const builder = query([row('a')]);
		vi.spyOn(source, 'buildQuery').mockResolvedValue(builder);
		source['search'].read = vi.fn(async () => [row('a')]);
		expect(await source.ownerCandidates(viewer, { kind: 'home' }, [reference('a').canonicalUri])).toEqual([reference('a')]);
		expect(notes.packMany).not.toHaveBeenCalled();
		expect(builder.andWhere).toHaveBeenCalledWith(expect.stringContaining('note.id IN'), expect.objectContaining({ timelineOwnerIds: ['a'] }));
	});
	test('compact ownership reads identity only and bypasses the scan transaction', async () => {
		const { source, notes } = fixture();
		const builder = query([row('a')]);
		const build = vi.spyOn(source, 'buildQuery').mockResolvedValue(builder);
		source['search'].read = vi.fn();
		expect(await source.ownerCandidates(viewer, { kind: 'home' }, [reference('a').canonicalUri], undefined, true)).toEqual([reference('a')]);
		expect(build).toHaveBeenCalledWith(viewer, { kind: 'home' }, { id: 'a' });
		expect(builder.select).toHaveBeenCalledWith(['note.id', 'note.uri']);
		expect(source['search'].read).not.toHaveBeenCalled();
		expect(notes.packMany).not.toHaveBeenCalled();
	});
	test('database-null policies match the omitted fields in the real packed user schema', async () => {
		const packed = payload('a');
		delete packed.user.makeNotesFollowersOnlyBefore;
		delete packed.user.makeNotesHiddenBefore;
		const { source, queryFactory } = fixture({ before: [row('a')], fresh: [row('a')], packed: [packed] });
		const result = await source.hydrateQuery(viewer, queryFactory, [reference('a')]);
		expect(result.map(item => item.payload.id)).toEqual(['a']);
		expect(result[0].validForMs).toBeNull();
	});

	test('a real numeric policy mismatch remains an authorization failure', async () => {
		const packed = payload('a');
		packed.user = { ...packed.user, makeNotesHiddenBefore: -60 };
		const { source, queryFactory } = fixture({ before: [row('a')], fresh: [row('a')], packed: [packed] });
		expect(await source.hydrateQuery(viewer, queryFactory, [reference('a')])).toEqual([]);
	});

	test('revocation while packing removes the body without replacement', async () => {
		const { source, queryFactory } = fixture({ fresh: [] });
		expect(await source.hydrateQuery(viewer, queryFactory, [reference('a')])).toEqual([]);
	});

	test('an edited audience or file list cannot reuse the packed body', async () => {
		for (const fresh of [{ ...row('a'), visibleUserIds: ['other'] }, { ...row('a'), fileIds: ['new-file'] }]) {
			const { source, queryFactory } = fixture({ fresh: [fresh] });
			expect(await source.hydrateQuery(viewer, queryFactory, [reference('a')])).toEqual([]);
		}
	});

	test('a canonical URI change invalidates a replayed reference', async () => {
		const edited = { ...row('a'), uri: 'https://changed.test/notes/a' };
		const { source, queryFactory } = fixture({ before: [edited], fresh: [edited] });
		expect(await source.hydrateQuery(viewer, queryFactory, [reference('a')])).toEqual([]);
	});

	test('a revoked nested quote is removed before returning the parent', async () => {
		const outer = { ...row('a'), renoteId: 'b' };
		const packed = { ...payload('a'), renoteId: 'b', renote: payload('b') };
		const { source, queryFactory } = fixture({ before: [outer], fresh: [outer], related: [outer], packed: [packed] });
		const result = await source.hydrateQuery(viewer, queryFactory, [reference('a')]);
		expect(result).toHaveLength(1);
		expect(result[0].payload.renote).toBeNull();
		expect(result[0].payload.renoteId).toBeNull();
	});

	test('a nested attachment changed while packing cannot leak its old payload', async () => {
		const outer = { ...row('a'), renoteId: 'b' };
		const quoted = { ...row('b'), fileIds: ['new-file'] };
		const packed = { ...payload('a'), renoteId: 'b', renote: { ...payload('b'), fileIds: ['old-file'] } };
		const { source, queryFactory } = fixture({ before: [outer], fresh: [outer], related: [outer, quoted], packed: [packed] });
		const result = await source.hydrateQuery(viewer, queryFactory, [reference('a')]);
		expect(result[0].payload.renote).toBeNull();
	});

	test('the list-specific root ACL does not inherit generic nested exclusions', async () => {
		const { source, queryFactory } = fixture({ related: [] });
		const result = await source.hydrateQuery(viewer, queryFactory, [reference('a')]);
		expect(result.map(item => item.payload.id)).toEqual(['a']);
	});

	test('followers and direct bodies always have a finite lease', async () => {
		for (const visibility of ['followers', 'specified'] as const) {
			const privateRow = { ...row('a'), visibility };
			const { source, queryFactory } = fixture({ before: [privateRow], fresh: [privateRow], packed: [{ ...payload('a'), visibility }] });
			const result = await source.hydrateQuery(viewer, queryFactory, [reference('a')]);
			expect(result[0].validForMs).toBe(60_000);
		}
	});

	test('a private nested quote and a channel body also have finite leases', async () => {
		const outer = { ...row('a'), renoteId: 'b' };
		const quoted = { ...row('b'), visibility: 'followers' as const };
		const packed = { ...payload('a'), renoteId: 'b', renote: { ...payload('b'), visibility: 'followers' as const } };
		const quoteFixture = fixture({ before: [outer], fresh: [outer], related: [outer, quoted], packed: [packed] });
		expect((await quoteFixture.source.hydrateQuery(viewer, quoteFixture.queryFactory, [reference('a')]))[0].validForMs).toBe(60_000);
		const channelFixture = fixture({ packed: [{ ...payload('a'), channelId: 'private-channel' }] });
		expect((await channelFixture.source.hydrateQuery(viewer, channelFixture.queryFactory, [reference('a')]))[0].validForMs).toBe(60_000);
	});

	test('keeps the selected reference order, not repository result order', async () => {
		const { source, queryFactory } = fixture({ before: [row('a'), row('b')], fresh: [row('b'), row('a')] });
		const result = await source.hydrateQuery(viewer, queryFactory, [reference('b'), reference('a')]);
		expect(result.map(item => item.payload.id)).toEqual(['b', 'a']);
	});

	test('an expired normal-body policy is rejected after packing', async () => {
		const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
		try {
			const author = { ...user, makeNotesHiddenBefore: -60 };
			const hidden = { ...row('a'), user: author } as unknown as MiNote;
			const { source, queryFactory } = fixture({ before: [hidden], fresh: [hidden], packed: [{ ...payload('a'), user: author } as unknown as Packed<'Note'>] });
			expect(await source.hydrateQuery(viewer, queryFactory, [reference('a')])).toEqual([]);
		} finally { spy.mockRestore(); }
	});

	test('normal bodies carry the earlier of author and viewer policy deadlines', async () => {
		const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
		try {
			const author = { ...user, makeNotesHiddenBefore: -60 };
			const timed = { ...row('a'), user: author } as unknown as MiNote;
			const { source, queryFactory } = fixture({ before: [timed], fresh: [timed], packed: [{ ...payload('a'), user: author } as unknown as Packed<'Note'>], deadline: new Date(now + 1500) });
			const result = await source.hydrateQuery(viewer, queryFactory, [reference('a')]);
			expect(result[0].validForMs).toBe(1500);
			expect(result[0].nextPolicyCheckAt).toBe(new Date(now + 1500).toISOString());
		} finally { spy.mockRestore(); }
	});
});

describe('relative normal-note policy clock', () => {
	test('uses the first exact deadline without leasing static public bodies', () => {
		expect(timelinePolicyDeadline(payload('a'), viewer.id, now)).toBeNull();
		expect(timelinePolicyDeadline({ ...payload('a'), user: { ...user, makeNotesHiddenBefore: -60, makeNotesFollowersOnlyBefore: -20 } } as unknown as Packed<'Note'>, viewer.id, now)).toBe(now + 20_000);
		expect(timelinePolicyDeadline({ ...payload('a'), userId: viewer.id, user: { ...user, makeNotesHiddenBefore: 0 } } as unknown as Packed<'Note'>, viewer.id, now)).toBeNull();
	});
});

describe('bounded local source pages', () => {
	function scanFixture(eligible: MiNote[]) {
		const scanned = Array.from({ length: 513 }, (_, i) => row(String(1000 - i).padStart(4, '0')));
		const candidateQuery = { select: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValue(scanned) };
		const eligibleQuery = { andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis() };
		const db = { getRepository: () => ({ createQueryBuilder: () => candidateQuery }) };
		const search = { read: vi.fn().mockResolvedValue(eligible) };
		const ids = { parse: () => ({ date: new Date(now) }), gen: vi.fn().mockReturnValue('date-boundary') };
		const source = new TimelineLocalSource(db as unknown as DataSource, { url: 'https://example.test' } as Config, search as unknown as GridspaceSearchService,
			{} as QueryService, {} as GridspaceIdentityService, {} as RoleService, {} as NoteEntityService, ids as unknown as IdService);
		vi.spyOn(source, 'buildQuery').mockResolvedValue(eligibleQuery as unknown as SelectQueryBuilder<MiNote>);
		return { source, candidateQuery, eligibleQuery, scanned, ids };
	}

	test('an empty filtered page advances through exactly 512 candidate IDs', async () => {
		const { source, candidateQuery, eligibleQuery, scanned } = scanFixture([]);
		const page = await source.readPage(viewer, { kind: 'home' }, { limit: 20 });
		expect(candidateQuery.limit).toHaveBeenCalledWith(513);
		expect(eligibleQuery.andWhere).toHaveBeenCalledWith('note.id IN (:...timelineWindow)', { timelineWindow: scanned.slice(0, 512).map(note => note.id) });
		expect(page.references).toEqual([]);
		expect(page.ended).toBe(false);
		expect(page.next?.noteId).toBe(scanned[511].id);
		expect(page.upper?.noteId).toBe(scanned[0].id);
	});
	test('a full eligible page never skips unreturned rows inside the window', async () => {
		const eligible = Array.from({ length: 21 }, (_, i) => row(String(1000 - i).padStart(4, '0')));
		const { source } = scanFixture(eligible);
		const page = await source.readPage(viewer, { kind: 'home' }, { limit: 20 });
		expect(page.references.map(ref => ref.noteId)).toEqual(eligible.slice(0, 20).map(note => note.id));
		expect(page.next?.noteId).toBe(eligible[19].id);
		expect(page.ended).toBe(false);
	});
});

describe('local timeline subscription SQL', () => {
	const config = loadConfig();
	const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db });
	let runner: QueryRunner;
	let source: TimelineLocalSource;
	beforeAll(async () => {
		await db.initialize();
		runner = db.createQueryRunner();
		await runner.connect();
		await runner.startTransaction();
		await runner.query('CREATE TEMP TABLE following ("followerId" text, "followeeId" text, "withReplies" boolean) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE channel_following ("followerId" text, "followeeId" text) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE "user" (id text, "isDeleted" boolean, "isSuspended" boolean) ON COMMIT DROP');
		await runner.query('ALTER TABLE "user" ADD COLUMN uri text');
		await runner.query('CREATE TEMP TABLE gridspace_link ("localUserId" text, "peerOrigin" text, "peerUserId" text, state text) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE note (id text, "userId" text, "userHost" text, visibility text, "channelId" text, "gridspaceShared" boolean, "replyId" text, "replyUserId" text, "renoteId" text, "renoteUserId" text, "renoteUserHost" text, text text, cw text, "fileIds" text[], "hasPoll" boolean) ON COMMIT DROP');
		await runner.query('ALTER TABLE note ADD COLUMN "multiNoteKind" text, ADD COLUMN "includeDefault" boolean, ADD COLUMN uri text');
		await runner.query('CREATE TEMP TABLE channel (id text) ON COMMIT DROP');
		await runner.query("INSERT INTO channel VALUES ('channel'), ('other-channel')");
		await runner.query('CREATE TEMP TABLE channel_muting ("channelId" text, "userId" text, "expiresAt" timestamptz) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE gridspace_channel_placement ("channelId" text, "canonicalUri" text, state text, "includeDefault" boolean) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE note_channel_placement ("noteId" text, "channelId" text, state text) ON COMMIT DROP');
		await runner.query('INSERT INTO "user" (id,"isDeleted","isSuspended") VALUES (\'viewer\',false,false), (\'followed\',false,false), (\'reply-enabled\',false,false), (\'outsider\',false,false), (\'linked\',false,false)');
		await runner.query("UPDATE \"user\" SET uri='https://peer.test/users/linked' WHERE id='linked'");
		await runner.query("INSERT INTO gridspace_link VALUES ('viewer','https://peer.test','linked','active')");
		await runner.query('INSERT INTO following VALUES (\'viewer\',\'followed\',false), (\'viewer\',\'reply-enabled\',true)');
		await runner.query('INSERT INTO channel_following VALUES (\'viewer\',\'channel\')');
		const add = async (id: string, author: string, opts: { host?: string; visibility?: string; shared?: boolean; reply?: string; replyAuthor?: string; channel?: string; renote?: string; renoteAuthor?: string; renoteHost?: string; text?: string | null; files?: string[] } = {}) => {
			await runner.query('INSERT INTO note VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,false)', [id, author, opts.host ?? null, opts.visibility ?? 'public', opts.channel ?? null, opts.shared ?? false, opts.reply ?? null, opts.replyAuthor ?? null, opts.renote ?? null, opts.renoteAuthor ?? null, opts.renoteHost ?? null, opts.text === undefined ? id : opts.text, opts.files ?? []]);
		};
		await add('self', 'viewer');
		await add('followed', 'followed', { host: 'remote.test' });
		await add('outsider', 'outsider', { host: 'remote.test' });
		await add('local', 'outsider');
		await add('shared', 'outsider', { host: 'peer.test', shared: true });
		await add('linked', 'linked', { visibility: 'home', host: 'peer.test' });
		await add('linked-private', 'linked', { visibility: 'followers', host: 'peer.test' });
		await add('channel', 'outsider', { channel: 'channel', host: 'peer.test' });
		await add('other-channel', 'viewer', { channel: 'other-channel' });
		await add('reply-target', 'outsider', { host: 'remote.test' });
		await add('private-target', 'outsider', { visibility: 'followers', host: 'remote.test' });
		await add('reply-default', 'followed', { reply: 'reply-target', replyAuthor: 'outsider', host: 'remote.test' });
		await add('reply-enabled', 'reply-enabled', { reply: 'reply-target', replyAuthor: 'outsider', host: 'remote.test' });
		await add('reply-private', 'reply-enabled', { reply: 'private-target', replyAuthor: 'outsider', host: 'remote.test' });
		await add('reply-self', 'followed', { reply: 'followed', replyAuthor: 'followed', host: 'remote.test' });
		await add('reply-viewer', 'followed', { reply: 'self', replyAuthor: 'viewer', host: 'remote.test' });
		await add('renote', 'followed', { renote: 'followed', renoteAuthor: 'followed', renoteHost: 'remote.test', text: null, host: 'remote.test' });
		await add('quote', 'followed', { renote: 'followed', renoteAuthor: 'followed', renoteHost: 'remote.test', text: 'quote', host: 'remote.test' });
		const search = { noteQuery: () => db.createQueryBuilder().setQueryRunner(runner).select('note.id', 'id').from('note', 'note')
			.innerJoin('user', 'user', '"user".id = note."userId"').leftJoin('note', 'reply', 'reply.id = note."replyId"') };
		source = new TimelineLocalSource(db, config, search as unknown as GridspaceSearchService,
			{ generateMutedNoteThreadQuery: () => {}, generateMutedUserRenotesQueryForNotes: () => {} } as unknown as QueryService,
			{ linkedUserId: async () => 'linked' } as unknown as GridspaceIdentityService,
			{ getUserPolicies: async () => ({ ltlAvailable: true }) } as unknown as RoleService, {} as NoteEntityService, {} as IdService);
	});
	afterAll(async () => {
		if (runner) { await runner.rollbackTransaction(); await runner.release(); }
		await db.destroy();
	});
	const read = async (options: Parameters<TimelineLocalSource['buildQuery']>[1]) => (await (await source.buildQuery(viewer, options)).getRawMany<{ id: string }>()).map(value => value.id).sort();
	test('inline link resolution matches generic subscription filters and observes unlinking', async () => {
		Object.assign(config, { gridspace: { enabled: true } });
		try {
			for (const options of [{ kind: 'home' }, { kind: 'social', withReplies: true }, { kind: 'home', withRenotes: false }] as const) {
				const compact = (await (await source.buildQuery(viewer, options, {})).getRawMany<{ id: string }>()).map(value => value.id).sort();
				expect(compact).toEqual(await read(options));
			}
			await runner.query("UPDATE gridspace_link SET state='revoked'");
			const ids = (await (await source.buildQuery(viewer, { kind: 'home' }, {})).getRawMany<{ id: string }>()).map(value => value.id);
			expect(ids).not.toContain('linked');
		} finally { await runner.query("UPDATE gridspace_link SET state='active'"); }
	});

	test('home follows current author and channel subscriptions and linked public identity', async () => {
		expect(await read({ kind: 'home' })).toEqual(['channel', 'followed', 'linked', 'quote', 'renote', 'reply-enabled', 'reply-self', 'reply-viewer', 'self']);
	});
	test('social adds local/shared public notes and optionally ordinary replies', async () => {
		expect(await read({ kind: 'social' })).toEqual(['channel', 'followed', 'linked', 'local', 'quote', 'renote', 'reply-enabled', 'reply-self', 'reply-viewer', 'self', 'shared']);
		expect(await read({ kind: 'social', withReplies: true })).toContain('reply-default');
		expect(await read({ kind: 'social', withReplies: true })).not.toContain('reply-private');
	});
	test('disabling renotes retains quoted notes and excludes pure renotes', async () => {
		const values = await read({ kind: 'home', withRenotes: false });
		expect(values).not.toContain('renote');
		expect(values).toContain('quote');
	});
});
