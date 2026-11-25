/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import type * as misskey from 'misskey-js';
import { Redis } from 'ioredis';
import { loadConfig } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import { MiChannel } from '@/models/Channel.js';
import { MiNote } from '@/models/Note.js';
import { MiNoteCreateDispatch, MiNoteCreateReceipt } from '@/models/NotePlacement.js';
import { createInputHash } from '@/core/NotePlacementService.js';
import { paramDef } from '@/server/api/endpoints/notes/create.js';
import { getValidator } from '../prelude/get-api-validator.js';
import { MiUser } from '@/models/User.js';
import { api, initTestDb, origin, role, signup, successfulApiCall } from '../utils.js';

describe('Channel-targeted native renotes', () => {
	test('keeps the original, replays once, and rejects a newly restricted source', async () => {
		const owner = await signup({ username: 'renoteowner' });
		const actor = await signup({ username: 'renoteactor' });
		const channel = await successfulApiCall({ endpoint: 'channels/create', user: actor, parameters: { name: 'renote target' } });
		const source = (await successfulApiCall({ endpoint: 'notes/create', user: owner, parameters: { text: 'native original' } })).createdNote;
		const request = { renoteId: source.id, includeDefault: false, channelIds: [], channelTargets: [{ origin, channelId: channel.id }], clientRequestId: randomUUID() };
		const result = await successfulApiCall({ endpoint: 'notes/create', user: actor, parameters: request });
		expect(result.createdNote).toMatchObject({ multiNoteKind: 'root', includeDefault: false, localOnly: true, renoteId: source.id, renote: { text: 'native original' } });
		expect((await successfulApiCall({ endpoint: 'channels/timeline', user: actor, parameters: { channelId: channel.id } })).map(n => n.id)).toContain(result.createdNote.id);
		expect((await successfulApiCall({ endpoint: 'notes/create', user: actor, parameters: request })).createdNote.id).toBe(result.createdNote.id);
		await successfulApiCall({ endpoint: 'blocking/create', user: owner, parameters: { userId: actor.id } });
		expect((await api('notes/create', { ...request, clientRequestId: randomUUID() }, actor)).status).toBe(400);
		expect((await successfulApiCall({ endpoint: 'notes/create', user: actor, parameters: request })).createdNote.id).toBe(result.createdNote.id);
	});
});

describe('Multi-note creation', () => {
	let author: misskey.entities.SignupResponse;
	let other: misskey.entities.SignupResponse;
	let first: string;
	let second: string;

	beforeAll(async () => {
		author = await signup({ username: 'author' });
		other = await signup({ username: 'reader' });
		first = (await api('channels/create', { name: 'first' }, author)).body.id;
		second = (await api('channels/create', { name: 'second' }, author)).body.id;
	});

	test('replays concurrent requests once, including a relative poll expiry', async () => {
		const clientRequestId = randomUUID();
		const request = { text: 'original', includeDefault: true, channelIds: [first, second], clientRequestId, poll: { choices: ['a', 'b'], expiredAfter: 600000 } };
		const responses = await Promise.all([api('notes/create', request, author), api('notes/create', request, author)]);
		expect(responses.map(r => r.status)).toEqual([200, 200]);
		const note = responses[0].body.createdNote;
		expect(responses[1].body.createdNote.id).toBe(note.id);
		expect(note.includeDefault).toBe(true);
		expect(note.channelPlacements?.map(p => p.channelId).sort()).toEqual([first, second].sort());
		for (const channelId of [first, second]) {
			const timeline = await api('channels/timeline', { channelId }, author);
			expect(timeline.body.filter(n => n.id === note.id)).toHaveLength(1);
			expect((await api('channels/show', { channelId }, author)).body.notesCount).toBe(1);
		}
		expect((await api('notes/create-status', { clientRequestId }, other)).body.status).toBe('missing');
		expect((await api('notes/create-status', { clientRequestId }, author)).body.createdNote?.id).toBe(note.id);
		expect((await api('notes/create', { ...request, text: 'changed' }, author)).status).toBe(400);
		expect((await api('notes/delete', { noteId: note.id }, author)).status).toBe(204);
		expect((await api('notes/create-status', { clientRequestId }, author)).body).toEqual({ status: 'deleted', createdNote: null });
		expect((await api('notes/create', request, author)).status).toBe(400);
	});

	test('recovers committed dispatches without adding another notification or note count', async () => {
		const db = await initTestDb(true);
		try {
			await api('following/create', { userId: author.id }, other);
			await api('following/update', { userId: author.id, notify: 'normal' }, other);
			const request = { text: 'durable', channelIds: [first], includeDefault: true, clientRequestId: randomUUID() };
			const note = (await api('notes/create', request, author)).body.createdNote;
			const dispatch = db.getRepository(MiNoteCreateDispatch);
			const settled = () => expect.poll(() => dispatch.existsBy({ noteId: note.id }), { timeout: 15000, interval: 100 }).toBe(false);
			await settled();
			const count = (await db.getRepository(MiUser).findOneByOrFail({ id: author.id })).notesCount;
			// The worker completed its external writes, but its SQL acknowledgement was lost.
			await dispatch.insert({ noteId: note.id, retryAt: new Date() });
			await settled();
			const notifications = (await api('i/notifications', { includeTypes: ['note'] }, other)).body;
			expect(notifications.filter(n => n.type === 'note' && n.note.id === note.id)).toHaveLength(1);
			expect((await db.getRepository(MiUser).findOneByOrFail({ id: author.id })).notesCount).toBe(count);
			expect((await api('channels/timeline', { channelId: first }, other)).body.filter(n => n.id === note.id)).toHaveLength(1);
		} finally {
			await db.destroy();
		}
	});

	test('publishes notes, role and antenna streams once when only the committed dispatch survives', async () => {
		const config = loadConfig();
		const db = await initTestDb(true);
		const subscriber = new Redis(config.redisForPubsub);
		try {
			const assigned = await role(author);
			expect((await api('admin/roles/assign', { userId: other.id, roleId: assigned.id }, author)).status).toBe(204);
			const antenna = await api('antennas/create', { name: 'dispatch', src: 'all', keywords: [['stream-replay']],
				excludeKeywords: [], users: [], caseSensitive: false, withReplies: true, withFile: false }, author);
			expect(antenna.status).toBe(200);
			const noteId = new IdService(config).gen();
			const seen: string[] = [];
			subscriber.on('message', (_channel, data) => {
				const event = JSON.parse(data);
				if ((event.message?.body?.id ?? event.message?.id) === noteId) seen.push(event.channel);
			});
			await subscriber.subscribe(config.host);
			// Simulate a stopped creator. Only its SQL rows are present, with no in-process callbacks.
			await db.transaction(async manager => {
				await manager.insert(MiNote, { id: noteId, userId: other.id, text: 'stream-replay', localOnly: true,
					visibility: 'public', includeDefault: true, multiNoteKind: 'root' });
				await manager.insert(MiNoteCreateDispatch, { noteId, retryAt: new Date() });
			});
			const jobs = db.getRepository(MiNoteCreateDispatch);
			const settled = () => expect.poll(() => jobs.existsBy({ noteId }), { timeout: 15000, interval: 100 }).toBe(false);
			await settled();
			const channels = ['notesStream', `roleTimelineStream:${assigned.id}`, `antennaStream:${antenna.body.id}`].sort();
			expect(seen.sort()).toEqual(channels);
			await jobs.insert({ noteId, retryAt: new Date() });
			await settled();
			expect(seen.sort()).toEqual(channels);
		} finally {
			subscriber.disconnect();
			await db.destroy();
		}
	});

	test('rejects incompatible destinations without reserving the key', async () => {
		const restricted = (await api('channels/create', { name: 'restricted', allowRenoteToExternal: false }, author)).body.id;
		const clientRequestId = randomUUID();
		const request = { text: 'hello', includeDefault: true, localOnly: true, channelIds: [first, restricted], clientRequestId };
		expect((await api('notes/create', request, author)).status).toBe(400);
		expect((await api('notes/create-status', { clientRequestId }, author)).body.status).toBe('missing');
		expect((await api('notes/create', { ...request, channelIds: [] }, author)).status).toBe(400);
		expect((await api('notes/create', { ...request, channelId: first }, author)).status).toBe(400);
		expect((await api('notes/create', { ...request, visibility: 'home' }, author)).status).toBe(400);
		const quoted = await api('notes/create', { ...request, gridspaceQuote: 'https://peer.example/notes/source' }, author);
		expect(quoted.status).toBe(400);
		expect(quoted.body).toMatchObject({ error: { code: 'INVALID_NOTE_PLACEMENT', info: { reason: 'incompatible-destination' } } });
		expect((await api('notes/create-status', { clientRequestId }, author)).body.status).toBe('missing');

		const dedicated = await api('notes/create', { ...request, includeDefault: false, localOnly: false }, author);
		expect(dedicated.status).toBe(200);
		const note = dedicated.body.createdNote;
		expect(note).toMatchObject({ includeDefault: false, multiNoteKind: 'root', localOnly: true, gridspaceShared: false });
		expect((await api('notes/show', { noteId: note.id }, other)).body.text).toBe('hello');
		expect((await api('notes/create', { renoteId: note.id }, other)).status).toBe(400);
	});

	test('uses the selected source channel policy for references and replays a committed single destination', async () => {
		const owner = await signup({ username: 'refowner' });
		const restricted = (await successfulApiCall({ endpoint: 'channels/create', parameters: { name: 'same channel only', allowRenoteToExternal: false }, user: owner })).id;
		const source = (await successfulApiCall({ endpoint: 'notes/create', user: author, parameters: {
			text: 'source', includeDefault: false, channelIds: [first, restricted], clientRequestId: randomUUID(),
		} })).createdNote;
		const canonical = origin + '/notes/' + source.id;
		const reference = (channelId: string) => canonical + '?' + new URLSearchParams({ gridspaceChannelOrigin: origin, gridspaceChannelId: channelId });
		const quote = reference(restricted);
		expect((await api('notes/create', { gridspaceQuote: quote }, author)).status).toBe(400);
		expect((await api('notes/create', { gridspaceQuote: quote, channelId: first }, author)).status).toBe(400);
		const outside = await api('notes/create', { gridspaceQuote: reference(first) }, author);
		expect(outside.status).toBe(200);
		expect(outside.body.createdNote).toMatchObject({ gridspaceQuote: reference(first), includeDefault: true, localOnly: true });

		const request = { gridspaceQuote: quote, includeDefault: false, channelIds: [restricted], clientRequestId: randomUUID() };
		expect((await api('notes/create', { ...request, includeDefault: true }, author)).status).toBe(400);
		expect((await api('notes/create', { ...request, channelIds: [restricted, first] }, author)).status).toBe(400);
		const result = await api('notes/create', request, author);
		expect(result.status).toBe(200);
		expect(result.body.createdNote).toMatchObject({ gridspaceQuote: quote, localOnly: true, includeDefault: false, channelPlacements: [{ channelId: restricted }] });
		expect((await api('mute/create', { userId: owner.id }, other)).status).toBe(204);
		const muted = await api('notes/show', { noteId: source.id }, other);
		expect(muted.body.channelPlacements?.map(row => row.channelId)).toEqual([first]);
		expect((await api('notes/create', { ...request, clientRequestId: randomUUID() }, other)).status).toBe(400);
		expect((await api('channels/update', { channelId: restricted, isArchived: true }, owner)).status).toBe(200);

		const reordered = canonical + '?' + new URLSearchParams({ gridspaceChannelId: restricted, gridspaceChannelOrigin: origin });
		const replay = await api('notes/create', { ...request, gridspaceQuote: reordered }, author);
		expect(replay.status).toBe(200);
		expect(replay.body.createdNote.id).toBe(result.body.createdNote.id);
		const mismatch = await api('notes/create', { ...request, gridspaceQuote: reference(first) }, author);
		expect(mismatch.body).toMatchObject({ error: { info: { reason: 'request-content-conflict' } } });
		expect((await api('notes/create', { ...request, clientRequestId: randomUUID() }, author)).status).toBe(400);
	});

	test('recovers a valid receipt after pairing with the source server ends', async () => {
		const db = await initTestDb(true);
		try {
			const request = { text: 'historical quote', includeDefault: false, channelIds: [first], clientRequestId: randomUUID() };
			const note = (await successfulApiCall({ endpoint: 'notes/create', parameters: request, user: author })).createdNote;
			const peer = 'https://former-peer.example';
			const gridspaceQuote = peer + '/notes/old?' + new URLSearchParams({ gridspaceChannelOrigin: peer, gridspaceChannelId: 'oldchannel' });
			const { clientRequestId, ...input } = { ...request, gridspaceQuote };
			// Reconstruct an already committed receipt with the same validated defaults used at creation.
			expect(getValidator(paramDef)(input)).toBe(true);
			await db.transaction(async manager => {
				await manager.update(MiNote, note.id, { gridspaceQuote });
				await manager.update(MiNoteCreateReceipt, { userId: author.id, clientRequestId }, { inputHash: createInputHash(input) });
			});
			const replay = await successfulApiCall({ endpoint: 'notes/create', parameters: { ...request, gridspaceQuote }, user: author });
			expect(replay.createdNote).toMatchObject({ id: note.id, gridspaceQuote });
			expect((await api('notes/create', { ...request, gridspaceQuote, clientRequestId: randomUUID() }, author)).status).toBe(400);
		} finally {
			await db.destroy();
		}
	});

	test('rechecks a legacy single-channel destination before committing a scoped reference', async () => {
		const source = (await successfulApiCall({ endpoint: 'notes/create', user: author, parameters: {
			text: 'single channel source', includeDefault: false, channelIds: [first], clientRequestId: randomUUID(),
		} })).createdNote;
		const destination = await successfulApiCall({ endpoint: 'channels/create', parameters: { name: 'closing channel' }, user: author });
		const gridspaceQuote = origin + '/notes/' + source.id + '?' + new URLSearchParams({ gridspaceChannelOrigin: origin, gridspaceChannelId: first });
		const db = await initTestDb(true);
		const gate = db.createQueryRunner();
		try {
			await gate.startTransaction();
			await gate.manager.update(MiChannel, destination.id, { isArchived: true });
			const pending = api('notes/create', { gridspaceQuote, channelId: destination.id }, author);
			// The initial destination lookup can still see the old version. Wait for the insert to reach the locked channel.
			await expect.poll(async () => {
				const [row] = await gate.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS waiting');
				return row.waiting;
			}).toBe(true);
			await gate.commitTransaction();
			expect((await pending).status).toBe(400);
			expect(await db.getRepository(MiNote).countBy({ channelId: destination.id })).toBe(0);
		} finally {
			if (gate.isTransactionActive) await gate.rollbackTransaction();
			await gate.release();
			await db.destroy();
		}
	});

	test('keeps the public original visible when the viewer blocks a placement owner', async () => {
		const reader = await signup({ username: 'chipreader' });
		const remoteOwned = (await api('channels/create', { name: 'owned by reader' }, other)).body.id;
		const root = await api('notes/create', { text: 'public', includeDefault: true, channelIds: [first, remoteOwned], clientRequestId: randomUUID() }, author);
		expect(root.status).toBe(200);
		expect((await api('blocking/create', { userId: other.id }, reader)).status).toBe(200);
		const shown = (await api('notes/show', { noteId: root.body.createdNote.id }, reader)).body;
		expect(shown.text).toBe('public');
		expect(shown.channelPlacements?.map(p => p.channelId)).toEqual([first]);
	});

	test('uses the author’s CW across ordinary and sensitive destinations, including no CW', async () => {
		const sensitive = (await api('channels/create', { name: 'sensitive destination', isSensitive: true }, other)).body.id;
		const text = 'An original with two channel placements';
		const cw = 'Author’s warning';
		const mixed = await api('notes/create', { text, cw, includeDefault: true, channelIds: [first, sensitive], clientRequestId: randomUUID() }, author);
		expect(mixed.status).toBe(200);
		const noteId = mixed.body.createdNote.id;
		const shown = (await api('notes/show', { noteId }, other)).body;
		expect(shown).toMatchObject({ id: noteId, text, cw, includeDefault: true });
		expect(shown.channelPlacements?.map(p => p.channelId).sort()).toEqual([first, sensitive].sort());
		for (const channelId of [first, sensitive]) {
			const timeline = await api('channels/timeline', { channelId }, other);
			expect(timeline.body.find(note => note.id === noteId)).toMatchObject({ id: noteId, text, cw });
		}

		const single = await api('notes/create', { text: 'No author warning', includeDefault: false, channelIds: [sensitive], clientRequestId: randomUUID() }, author);
		expect(single.status).toBe(200);
		const dedicated = single.body.createdNote;
		expect(dedicated).toMatchObject({ cw: null, includeDefault: false, channelPlacements: [{ channelId: sensitive }] });
		const timeline = await api('channels/timeline', { channelId: sensitive }, other);
		expect(timeline.body.find(note => note.id === dedicated.id)).toMatchObject({ id: dedicated.id, cw: null });
	});

	test('rejects archived or blocked sensitive destinations atomically', async () => {
		const owner = await signup({ username: 'sensitiveowner' });
		const archived = (await api('channels/create', { name: 'archived', isSensitive: true }, owner)).body.id;
		const blocked = (await api('channels/create', { name: 'blocked', isSensitive: true }, owner)).body.id;
		expect((await api('channels/update', { channelId: archived, isArchived: true }, owner)).status).toBe(200);
		const reject = async (channelId: string) => {
			const clientRequestId = randomUUID();
			const response = await api('notes/create', { text: 'must not publish', includeDefault: true, channelIds: [first, channelId], clientRequestId }, author);
			expect(response.status).toBe(400);
			expect((await api('notes/create-status', { clientRequestId }, author)).body.status).toBe('missing');
		};
		await reject(archived);
		expect((await api('blocking/create', { userId: author.id }, owner)).status).toBe(200);
		await reject(blocked);
	});

	test('checks descendant writes and inherits active channels without ordinary distribution', async () => {
		const root = (await api('notes/create', { text: 'root', channelIds: [first], includeDefault: false, clientRequestId: randomUUID() }, author)).body.createdNote;
		const reply = await api('notes/create', { replyId: root.id, text: 'child' }, other);
		expect(reply.status).toBe(200);
		expect(reply.body.createdNote).toMatchObject({ replyId: root.id, multiNoteKind: 'conversation-reply', includeDefault: false, localOnly: true });
		expect(reply.body.createdNote.channelPlacements).toMatchObject([{ channelId: first, canRemove: false }]);
		const db = await initTestDb(true);
		const redis = new Redis(loadConfig().redisForTimelines);
		const key = 'list:channelTimeline:' + first;
		const childId = reply.body.createdNote.id;
		try {
			await expect.poll(() => db.getRepository(MiNoteCreateDispatch).existsBy({ noteId: childId }), { timeout: 15000 }).toBe(false);
			await expect.poll(() => redis.lpos(key, childId), { timeout: 15000 }).not.toBeNull();
			for (const allowPartial of [true, false]) {
				expect(await redis.lrem(key, 0, childId)).toBe(1);
				expect(await redis.lpos(key, root.id)).not.toBeNull();
				const channel = await api('channels/timeline', { channelId: first, limit: 1, allowPartial }, author);
				expect(channel.body.map(n => n.id)).toEqual([childId]);
				expect(await redis.lpos(key, childId)).toBe(0);
			}
		} finally {
			await redis.quit();
			await db.destroy();
		}
		expect((await api('notes/timeline', {}, author)).body.some(n => n.id === reply.body.createdNote.id)).toBe(false);
		expect((await api('notes/local-timeline', {}, author)).body.some(n => n.id === reply.body.createdNote.id)).toBe(false);
		const unrelated = await signup({ username: 'descendant' });
		await api('blocking/create', { userId: unrelated.id }, author);
		expect((await api('notes/create', { replyId: reply.body.createdNote.id, text: 'child of child' }, unrelated)).status).toBe(400);
	});

	test('retains the legacy single-channel API and reply inheritance', async () => {
		const legacy = await api('notes/create', { text: 'legacy', channelId: first }, author);
		expect(legacy.status).toBe(200);
		expect(legacy.body.createdNote).toMatchObject({ channelId: first, includeDefault: false, localOnly: true });
		const reply = await api('notes/create', { text: 'reply', replyId: legacy.body.createdNote.id }, other);
		expect(reply.status).toBe(200);
		expect(reply.body.createdNote.channelId).toBe(first);
		expect(reply.body.createdNote.multiNoteKind).toBeUndefined();
	});
});
