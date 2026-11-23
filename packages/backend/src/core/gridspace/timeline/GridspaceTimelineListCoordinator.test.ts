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
import type { GridspacePrivateService } from '../GridspacePrivateService.js';
import type { GridspaceNoteService } from '../GridspaceNoteService.js';
import type { GridspaceClipReferenceService } from '../GridspaceClipReferenceService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { GridspaceTimelineService } from './GridspaceTimelineService.js';
import { TimelineSessionStore } from './TimelineSessionStore.js';
import type { TimelineLocalSource } from './TimelineLocalSource.js';
import type { TimelineReferenceService } from './TimelineReferenceService.js';
import type { GridspaceTimelineListSourceService } from './GridspaceTimelineListSourceService.js';
import type { TimelineFavoriteSource } from './TimelineFavoriteSource.js';
import type { TimelineItem, TimelineOptions, TimelinePosition, TimelineReference } from './timeline-protocol.js';

const viewer = { id: 'listCoordinator' } as MiLocalUser;
const prefix = `timeline-list-coordinator:${randomUUID()}:`;
const secret = 'GRIDSPACE_LIST_COORDINATOR_TEST_SECRET';
let previousSecret: string | undefined;
let redis: Redis.Redis;
beforeAll(() => {
	previousSecret = process.env[secret]; process.env[secret] = Buffer.alloc(32, 8).toString('base64');
	redis = new Redis.Redis({ ...loadConfig().redis, keyPrefix: prefix });
});
afterAll(async () => {
	const keys = await redis.keys(`${prefix}*`);
	if (keys.length) await redis.del(...keys.map(key => key.slice(prefix.length)));
	await redis.quit();
	if (previousSecret === undefined) delete process.env[secret]; else process.env[secret] = previousSecret;
});

function row(source: 'local' | 'peer', at: number, noteId = `${source[0]}${String(at).padStart(8, '0')}`, sourceId?: string): TimelineReference {
	return { source, noteId, sourceId, canonicalUri: `https://${source}.example/notes/${noteId}`, sortAt: String(at * 1000), normalized: true, generation: 1 };
}

function fixture(options: TimelineOptions, originalLocal: TimelineReference[], originalPeer: TimelineReference[]) {
	const local = mockDeep<TimelineLocalSource>(); const lists = mockDeep<GridspaceTimelineListSourceService>();
	const favorites = mockDeep<TimelineFavoriteSource>(); const references = mockDeep<TimelineReferenceService>();
	const delegated = mockDeep<GridspacePrivateService>(); const shared = mockDeep<GridspaceNoteService>();
	const rows = { local: [...originalLocal], peer: [...originalPeer] };
	const imports = new Map<string, { id: string; uri: string; createdAt: string }>();
	const events: { sequence: string; kind: 'insert'; noteId: string; canonicalUri: string }[] = [];
	const ascending = options.kind === 'clip' && options.order === 'oldest';
	const positionId = (ref: TimelinePosition) => ref.sourceId ?? ref.noteId!;
	const select = (source: 'local' | 'peer', position: { before?: TimelinePosition; upper?: TimelinePosition; fromAt?: number; untilAt?: number }, count = 51) => {
		if (options.kind === 'favorites') for (const boundary of [position.before, position.upper]) {
			if (boundary && !boundary.sourceId) throw new GridspaceLinkError('INVALID_CURSOR');
		}
		return rows[source].filter(ref => (!position.before || (ascending ? positionId(ref) > positionId(position.before) : positionId(ref) < positionId(position.before))) &&
			(!position.upper || positionId(ref) <= positionId(position.upper)) && (position.fromAt == null || Number(ref.sortAt) >= position.fromAt * 1000) &&
			(position.untilAt == null || Number(ref.sortAt) <= position.untilAt * 1000)).sort((a, b) => (ascending ? 1 : -1) * (Number(a.sortAt) - Number(b.sortAt))).slice(0, count);
	};
	const page = (source: 'local' | 'peer', position: { before?: TimelinePosition; upper?: TimelinePosition; fromAt?: number; untilAt?: number }, limit = 50) => {
		const candidates = select(source, position, limit + 1); const selected = candidates.slice(0, limit);
		const ceiling = [...rows[source]].sort((a, b) => positionId(a) < positionId(b) ? 1 : -1)[0] ?? null;
		return { references: selected, next: candidates.length > limit ? selected.at(-1)! : null, upper: position.upper ?? ceiling, ended: candidates.length <= limit };
	};
	const hydrate = (selected: TimelineReference[]) => {
		if (selected.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		return selected.filter(ref => rows.local.some(current => current.noteId === ref.noteId && current.sourceId === ref.sourceId)).map(reference => ({
			reference, payload: { id: reference.noteId, uri: reference.canonicalUri, createdAt: new Date(Number(reference.sortAt) / 1000).toISOString() }, validForMs: null, nextPolicyCheckAt: null,
		}));
	};
	const owners = (uris: string[], upper?: TimelinePosition | null) => {
		if (uris.length > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		return upper === null ? [] : rows.local.filter(ref => uris.includes(ref.canonicalUri) && (!upper || positionId(ref) <= positionId(upper)));
	};
	lists.readPage.mockImplementation(async (_viewer, _opts, position) => page('local', position, position.limit));
	lists.hydrate.mockImplementation(async (_viewer, _opts, selected) => hydrate(selected) as never);
	lists.ownerReferences.mockImplementation(async (_viewer, _opts, uris, upper) => owners(uris, upper));
	favorites.readPage.mockImplementation(async (_viewer, position) => page('local', position, position.limit) as never);
	favorites.hydrate.mockImplementation(async (_viewer, selected) => hydrate(selected) as never);
	favorites.ownerReferences.mockImplementation(async (_viewer, uris, upper) => owners(uris, upper) as never);
	local.nextViewerPolicyCheck.mockResolvedValue(null);
	references.status.mockResolvedValue({ generation: 1, currentSequence: '0' });
	references.currentPosition.mockResolvedValue('0');
	references.getMany.mockImplementation(async ids => rows.local.filter(ref => ids.includes(ref.noteId)));
	references.changes.mockImplementation(async after => ({ events: events.filter(event => Number(event.sequence) > Number(after)), cursor: String(events.length), hasMore: false, resetRequired: false }) as never);
	delegated.timeline.mockImplementation(async (_viewer, input) => {
		if ((input.ids?.length ?? 0) > 100) throw new GridspaceLinkError('INVALID_REQUEST');
		if (input.anchor) return { references: rows.peer.filter(ref => ref.canonicalUri === input.anchor), next: null, upper: null, sequence: '0', generation: 1, changed: false, notes: [], newReferences: [], validForMs: 10000 } as never;
		const selected = input.ids ? rows.peer.filter(ref => input.ids!.includes(ref.noteId)) : [];
		return { ...(input.ids ? { references: selected, next: null, upper: null } : page('peer', input)),
			sequence: '0', generation: 1, changed: false, validForMs: 10000, newReferences: [],
			notes: selected.filter(ref => !ref.public || input.includePublicBodies).map(ref => ({ id: ref.noteId, uri: ref.canonicalUri, text: input.includePublicBodies ? 'Public commentary' : 'protected', origin: 'https://peer.example', ...(input.includePublicBodies ? { renoteId: null, renoteUnavailable: true } : {}) })),
		} as never;
	});
	shared.historyNotes.mockImplementation(async ids => {
		const result = new Map();
		for (const id of ids) {
			let note = imports.get(id);
			if (!note) {
				const original = rows.peer.find(ref => ref.noteId === id)!;
				note = { id: `l${String(1000 + imports.size).padStart(8, '0')}`, uri: original.canonicalUri, createdAt: new Date(1000).toISOString() };
				imports.set(id, note);
				rows.local.push({ ...original, noteId: note.id, sortAt: String(1000000 + imports.size * 1000), source: 'local' });
				events.push({ sequence: String(events.length + 1), kind: 'insert', noteId: note.id, canonicalUri: note.uri });
			}
			result.set(id, note);
		}
		return result;
	});
	lists.hydrateImported.mockImplementation(async (_viewer, _opts, selected) => selected.map(reference => ({ reference, payload: { id: reference.noteId, uri: reference.canonicalUri, text: 'public import' }, validForMs: null, nextPolicyCheckAt: null })) as never);
	const sessions = new TimelineSessionStore(redis);
	const service = new GridspaceTimelineService({ url: 'https://local.example', gridspace: { enabled: true, timelineEnabled: true, communityId: 'test', peerUrl: 'https://peer.example', keyId: 'test', secretEnv: secret } } as Config,
		sessions, local, references, delegated, lists, favorites, shared);
	const addUnrelated = () => events.push({ sequence: String(events.length + 1), kind: 'insert', noteId: 'unrelated', canonicalUri: 'https://other.example/notes/unrelated' });
	const all = async (initial?: Awaited<ReturnType<GridspaceTimelineService['page']>>) => {
		const output: TimelineItem[] = []; let current = initial ?? await service.page(viewer, options, 20);
		for (let n = 0; n < 20; n++) {
			expect(current.complete).toBe(true); output.push(...current.items);
			if (!current.nextCursor) return output;
			current = await service.page(viewer, options, 20, current.nextCursor);
		}
		throw new Error('Unexpected endless continuation');
	};
	return { service, sessions, rows, delegated, favorites, lists, shared, imports, addUnrelated, all, page };
}

test('clip reference sources keep local and peer bodies through pagination and revalidation', async () => {
	const options = { kind: 'clip', clipId: 'clip', clipOrigin: 'https://local.example' } as const;
	const f = fixture(options, [row('local', 80)], [row('peer', 90)]);
	const clips = mockDeep<GridspaceClipReferenceService>();
	clips.readPage.mockImplementation(async (_viewer, _options, source, position) => f.page(source, position, position.limit));
	clips.ownerReferences.mockImplementation(async (_viewer, _options, uris) => f.rows.local.filter(row => uris.includes(row.canonicalUri)));
	clips.hydrate.mockImplementation(async (_viewer, _options, selected) => selected.filter(ref => f.rows[ref.source].some(row => row.noteId === ref.noteId)).map(reference => ({ reference,
		representation: reference.source === 'local' ? 'normal' : 'delegated', payload: { id: reference.noteId }, validForMs: 5000, nextPolicyCheckAt: null })) as never);
	f.service['clipReferences'] = clips;
	const first = await f.service.page(viewer, options, 1);
	expect(first.items[0].key).toBe(f.rows.peer[0].canonicalUri);
	const second = await f.service.page(viewer, options, 1, first.nextCursor!);
	expect(second.items[0].key).toBe(f.rows.local[0].canonicalUri);
	const check = await f.service.changes(viewer, { session: first.session, revision: first.revision, updatesCursor: first.updatesCursor, refs: first.items.map(row => row.ref), phase: 'validate' });
	expect(check.items[0].key).toBe(first.items[0].key);
	f.rows.peer.length = 0;
	const revoked = await f.service.changes(viewer, { session: first.session, revision: first.revision, updatesCursor: check.updatesCursor, refs: first.items.map(row => row.ref), phase: 'validate' });
	expect(revoked.items).toEqual([]);
	expect(revoked.removed).toEqual([first.items[0].key]);
	expect(f.delegated.timeline).not.toHaveBeenCalled();
});

test.each(['newest', 'oldest'] as const)('clip reference reset includes its anchor in %s order', async order => {
	const options = { kind: 'clip', clipId: 'clip', clipOrigin: 'https://local.example', order } as const;
	const f = fixture(options, [row('local', 50), row('local', 70)], [row('peer', 60), row('peer', 80)]);
	const clips = mockDeep<GridspaceClipReferenceService>();
	clips.readPage.mockImplementation(async (_viewer, _options, source, position) => position.uris
		? { references: f.rows[source].filter(ref => position.uris!.includes(ref.canonicalUri)), next: null, upper: null, ended: true }
		: f.page(source, position, position.limit));
	clips.ownerReferences.mockImplementation(async (_viewer, _options, uris) => f.rows.local.filter(row => uris.includes(row.canonicalUri)));
	clips.hydrate.mockImplementation(async (_viewer, _options, selected) => selected.map(reference => ({ reference,
		representation: reference.source === 'local' ? 'normal' : 'delegated', payload: { id: reference.noteId }, validForMs: 5000, nextPolicyCheckAt: null })) as never);
	f.service['clipReferences'] = clips;
	const result = await f.service.page(viewer, options, 20, undefined, 'unified', f.rows.peer[0].canonicalUri);
	expect(result.items.map(item => item.sortKey.sortAt)).toEqual((order === 'oldest' ? [60, 70, 80] : [60, 50]).map(n => String(n * 1000)));
});

describe('other-list coordinator with real Redis sessions', () => {
	test('keeps a public profile page when an unimportable reference needs a delegated placeholder', async () => {
		const options = { kind: 'profile', userId: 'profile' } as const;
		const original = row('local', 80);
		const missing = { ...row('peer', 70), public: true };
		const f = fixture(options, [original], [missing]);
		f.shared.historyNotes.mockResolvedValue(new Map());
		const page = await f.service.page(viewer, options, 20);
		expect(page.items.map(item => item.key)).toEqual([original.canonicalUri, missing.canonicalUri]);
		expect(page.items[1]).toMatchObject({ representation: 'delegated', payload: { text: 'Public commentary', renoteId: null, renoteUnavailable: true } });
		expect(page.items[1].validForMs).toBeGreaterThan(0);
		expect(page.items[1].validForMs).toBeLessThanOrEqual(10000);
		expect(f.delegated.timeline).toHaveBeenCalledWith(viewer, expect.objectContaining({ kind: 'profile', userId: 'profile', ids: [missing.noteId], includePublicBodies: true }));
		expect(f.imports.size).toBe(0);
	});

	test('public fallback preserves roots without requiring a private account grant', async () => {
		const options = { kind: 'profile', userId: 'profile' } as const;
		const original = row('local', 80);
		const f = fixture(options, [original], [{ ...row('peer', 70), public: true }]);
		f.shared.historyNotes.mockResolvedValue(new Map());
		const page = await f.service.page(viewer, options, 20);
		expect(page.items).toHaveLength(2);
		expect(page.items[1].payload).toMatchObject({ text: 'Public commentary', renoteUnavailable: true });
		expect(f.delegated.notes).not.toHaveBeenCalled();
		expect(f.imports.size).toBe(0);
	});

	test('a revoked public reference never falls back to an old delegated body', async () => {
		const options = { kind: 'profile', userId: 'profile' } as const;
		const missing = { ...row('peer', 70), public: true };
		const f = fixture(options, [], [missing]);
		f.shared.historyNotes.mockImplementation(async () => { f.rows.peer = []; return new Map(); });
		const page = await f.service.page(viewer, options, 20);
		expect(page.items).toEqual([]);
		expect(f.delegated.timeline.mock.calls.some(([, input]) => input.includePublicBodies)).toBe(false);
	});
	test('a delegated outage is not silently treated as an empty profile', async () => {
		const options = { kind: 'profile', userId: 'profile' } as const;
		const f = fixture(options, [], [{ ...row('peer', 70), public: true }]);
		f.shared.historyNotes.mockResolvedValue(new Map());
		const read = f.delegated.timeline.getMockImplementation()!;
		f.delegated.timeline.mockImplementation(async (user, input) => { if (input.includePublicBodies) throw new GridspaceLinkError('PEER_UNAVAILABLE'); return read(user, input); });
		await expect(f.service.page(viewer, options, 20)).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' });
	});
	test('favorites page on save identity while body hydration keeps the distinct note identity', async () => {
		const locals = Array.from({ length: 60 }, (_, i) => row('local', 300 - i * 2, `n${String(i + 1).padStart(8, '0')}`, `f${String(300 - i * 2).padStart(8, '0')}`));
		const peers = Array.from({ length: 65 }, (_, i) => row('peer', 299 - i * 2, `n${String(200 - i).padStart(8, '0')}`, `f${String(299 - i * 2).padStart(8, '0')}`));
		const f = fixture({ kind: 'favorites' }, locals, peers);
		const first = await f.service.page(viewer, { kind: 'favorites' }, 20); f.addUnrelated();
		const actual = await f.all(first);
		const expected = [...locals, ...peers].sort((a, b) => Number(b.sortAt) - Number(a.sortAt));
		expect(actual.map(item => item.key)).toEqual(expected.map(ref => ref.canonicalUri));
		expect(actual.map(item => item.payload.id)).toEqual(expected.map(ref => ref.noteId));
		expect(f.delegated.timeline.mock.calls.some(([, input]) => input.before?.sourceId === peers[49].sourceId)).toBe(true);
		expect(f.favorites.readPage.mock.calls.some(([, input]) => input.before?.sourceId === locals[49].sourceId)).toBe(true);
	});

	test('oldest clip paging preserves the original maximum ceiling when a new note is appended', async () => {
		const peers = Array.from({ length: 65 }, (_, i) => row('peer', i + 1));
		const options = { kind: 'clip', clipId: 'clip', order: 'oldest' } as const;
		const f = fixture(options, [], peers);
		const first = await f.service.page(viewer, options, 20);
		f.rows.peer.push(row('peer', 90)); f.addUnrelated();
		const actual = await f.all(first);
		expect(actual.map(item => item.key)).toEqual(peers.map(ref => ref.canonicalUri));
		const continuation = f.delegated.timeline.mock.calls.find(([, input]) => input.before?.noteId === peers[49].noteId)?.[1];
		expect(continuation?.upper?.noteId).toBe(peers[64].noteId);
		expect(actual.some(item => item.key === row('peer', 90).canonicalUri)).toBe(false);
	});

	test('oldest clip reset at an anchor starts at that note and preserves the upper snapshot bound', async () => {
		const peers = Array.from({ length: 60 }, (_, i) => row('peer', i + 1));
		const options = { kind: 'clip', clipId: 'clip', order: 'oldest' } as const;
		const f = fixture(options, [], peers);
		const first = await f.service.page(viewer, options, 10, undefined, 'unified', peers[39].canonicalUri);
		f.rows.peer.push(row('peer', 80));
		const actual = await f.all(first);
		expect(actual.map(item => item.key)).toEqual(peers.slice(39).map(ref => ref.canonicalUri));
		expect(f.delegated.timeline.mock.calls.some(([, input]) => input.fromAt === 40)).toBe(true);
		expect(JSON.parse((await f.sessions.getSession(first.session))!).merge.peer.upper.noteId).toBe(peers[59].noteId);
	});

	test('profile public imports keep original peer continuation after first-page cache creation', async () => {
		const peers = Array.from({ length: 70 }, (_, i) => ({ ...row('peer', 70 - i), public: true }));
		const original = row('local', 80);
		const options = { kind: 'profile', userId: 'profile' } as const;
		const f = fixture(options, [original], peers);
		const first = await f.service.page(viewer, options, 20);
		expect(first.items.every(item => item.representation === 'normal')).toBe(true);
		expect(f.imports.size).toBe(19);
		const actual = await f.all(first);
		expect(actual.map(item => item.key)).toEqual([original, ...peers].map(ref => ref.canonicalUri));
		expect(new Set(actual.map(item => item.key)).size).toBe(71);
		expect(f.imports.size).toBe(70);
		expect(f.delegated.timeline.mock.calls.some(([, input]) => input.before?.noteId === peers[49].noteId)).toBe(true);
		expect(f.lists.readPage.mock.calls[0][2]).toMatchObject({ upper: undefined });
	});

	test('an unrelated insertion between profile pages does not replace the snapshot or lose old rows', async () => {
		const locals = Array.from({ length: 70 }, (_, i) => row('local', 100 - i));
		const options = { kind: 'profile', userId: 'profile' } as const;
		const f = fixture(options, locals, []);
		const first = await f.service.page(viewer, options, 20); f.addUnrelated();
		const actual = await f.all(first);
		expect(actual.map(item => item.key)).toEqual(locals.map(ref => ref.canonicalUri));
	});
});
