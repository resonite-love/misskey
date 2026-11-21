/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { entities } from 'misskey-js';
import { loadConfig } from '@/config.js';
import { MiFollowing } from '@/models/Following.js';
import { MiRelay } from '@/models/Relay.js';
import { MiNote } from '@/models/Note.js';
import { MiNoteCreateDispatch } from '@/models/NotePlacement.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import { api, initTestDb, origin, signup, simpleGet, successfulApiCall } from '../utils.js';

describe('Per-note relay delivery', () => {
	const followerInbox = 'https://follower.example/inbox';
	const relayInboxes = ['https://first-relay.example/inbox', 'https://second-relay.example/inbox'];
	const normalInboxes = [followerInbox, ...relayInboxes].sort();
	const publicAudience = 'https://www.w3.org/ns/activitystreams#Public';

	let db: DataSource;
	let author: entities.SignupResponse;
	let voter: entities.SignupResponse;
	let queue: Queue<{ to: string; content: string }>;

	beforeAll(async () => {
		db = await initTestDb(true);
		const root = await signup({ username: 'root' });
		expect((await api('admin/update-meta', { federation: 'all' }, root)).status).toBe(204);
		author = await signup();
		voter = await signup();
		const follower = await signup({ host: 'follower.example' });
		await db.getRepository(MiFollowing).insert({
			id: voter.id,
			followeeId: author.id,
			followerId: follower.id,
			followerHost: 'follower.example',
			followerInbox,
		});
		await db.getRepository(MiRelay).insert([
			{ id: author.id, inbox: relayInboxes[0], status: 'accepted' },
			{ id: voter.id, inbox: relayInboxes[1], status: 'accepted' },
		]);
		queue = new Queue(QUEUE.DELIVER, baseQueueOptions(loadConfig(), QUEUE.DELIVER));
		await queue.pause();
	});

	afterAll(async () => {
		if (queue) {
			await queue.drain();
			await queue.resume();
			await queue.close();
		}
		if (db) await db.destroy();
	});

	async function deliveries(note: entities.Note, activityType: string) {
		const jobs = await queue.getJobs(['waiting', 'paused'], 0, -1);
		return jobs.filter(job => job.data.content.includes(`/notes/${note.id}`))
			.map(job => ({ to: job.data.to, activity: JSON.parse(job.data.content) }))
			.filter(job => job.activity.type === activityType);
	}

	async function recipients(note: entities.Note, activityType: string) {
		return (await deliveries(note, activityType)).map(job => job.to).sort();
	}

	function expectHomeAudience(object: { to: string[]; cc: string[] }) {
		expect(object.to).toEqual([`${origin}/users/${author.id}/followers`]);
		expect(object.cc).toContain(publicAudience);
	}

	test('preserves follower delivery while skipping every relay for the note and its updates', async () => {
		const normal = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { text: 'Normal delivery', poll: { choices: ['one', 'two'] } }, user: author,
		})).createdNote;
		const noRelay = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { text: 'Skip relays', noRelay: true, poll: { choices: ['one', 'two'] } }, user: author,
		})).createdNote;
		const local = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { text: 'Local federation mode', localOnly: true, noRelay: true }, user: author,
		})).createdNote;
		expect(normal.noRelay).toBe(false);
		expect(noRelay.noRelay).toBe(true);
		expect(noRelay.localOnly).toBe(false);
		expect(noRelay.visibility).toBe('public');
		const apNote = await simpleGet(`notes/${noRelay.id}`, 'application/activity+json');
		expect(apNote.status).toBe(200);
		expectHomeAudience(apNote.body);
		expect(local.noRelay).toBe(false);
		expect(local.localOnly).toBe(true);
		expect((await successfulApiCall({ endpoint: 'notes/show', parameters: { noteId: noRelay.id }, user: author })).noRelay).toBe(true);

		for (const note of [normal, noRelay]) {
			expect((await api('notes/polls/vote', { noteId: note.id, choice: 0 }, voter)).status).toBe(204);
			expect((await api('i/pin', { noteId: note.id }, author)).status).toBe(200);
			expect((await api('i/unpin', { noteId: note.id }, author)).status).toBe(200);
			expect((await api('notes/delete', { noteId: note.id }, author)).status).toBe(204);
		}

		const activityTypes = ['Create', 'Update', 'Add', 'Remove', 'Delete'];
		await vi.waitFor(async () => {
			for (const type of activityTypes) {
				expect(await recipients(normal, type), `normal ${type}`).toEqual(normalInboxes);
				expect(await recipients(noRelay, type), `noRelay ${type}`).toEqual([followerInbox]);
			}
		}, 10000);
		// Relay signatures are generated asynchronously after direct delivery is queued.
		await setTimeout(300);
		for (const type of activityTypes) expect(await recipients(noRelay, type)).toEqual([followerInbox]);
		const [{ activity: created }] = await deliveries(noRelay, 'Create');
		expectHomeAudience(created);
		expectHomeAudience(created.object);
		const [{ activity: updated }] = await deliveries(noRelay, 'Update');
		expectHomeAudience(updated);
		expectHomeAudience(updated.object);
		expect(await recipients(local, 'Create')).toEqual([]);
	}, 20000);

	test.each([false, true])('recovers a MultiNote Create with its saved relay choice (%s) and audience', async noRelay => {
		const channel = await successfulApiCall({ endpoint: 'channels/create', parameters: { name: 'delivery' }, user: author });
		const request = { text: 'MultiNote delivery', includeDefault: true, channelIds: [channel.id], clientRequestId: randomUUID() };
		const note = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { ...request, noRelay }, user: author,
		})).createdNote;
		expect(note).toMatchObject({ noRelay, localOnly: false, visibility: 'public', multiNoteKind: 'root' });
		expect(await db.getRepository(MiNote).findOneByOrFail({ id: note.id })).toMatchObject({ noRelay, federateAsHome: noRelay });
		const receipt = await successfulApiCall({ endpoint: 'notes/create-status', parameters: { clientRequestId: request.clientRequestId }, user: author });
		expect(receipt.createdNote).toMatchObject({ id: note.id, noRelay });
		const same = await successfulApiCall({ endpoint: 'notes/create', parameters: noRelay ? { ...request, noRelay } : request, user: author });
		expect(same.createdNote.id).toBe(note.id);
		expect((await api('notes/create', { ...request, noRelay: !noRelay }, author)).status).toBe(400);

		const dispatch = db.getRepository(MiNoteCreateDispatch);
		const verifyDelivery = async () => {
			await expect.poll(() => dispatch.existsBy({ noteId: note.id }), { timeout: 15000 }).toBe(false);
			const sent = await deliveries(note, 'Create');
			expect(sent.map(job => job.to).sort()).toEqual(noRelay ? [followerInbox] : normalInboxes);
			for (const { activity } of sent) {
				for (const object of [activity, activity.object]) {
					if (noRelay) expectHomeAudience(object);
					else expect(object.to).toContain(publicAudience);
				}
			}
		};
		await verifyDelivery();
		// Replay from SQL alone, with a fresh delivery queue for this note.
		const queued = await queue.getJobs(['waiting', 'paused'], 0, -1);
		for (const job of queued) if (job.data.content.includes(`/notes/${note.id}`)) await job.remove();
		await dispatch.insert({ noteId: note.id, retryAt: new Date() });
		await verifyDelivery();
	}, 40000);

	test('retains the public audience of existing notes and sends new renotes as home', async () => {
		const older = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { text: 'Existing note fixture' }, user: author,
		})).createdNote;
		await db.getRepository(MiNote).update(older.id, { noRelay: true });
		const original = await simpleGet(`notes/${older.id}`, 'application/activity+json');
		expect(original.status).toBe(200);
		expect(original.body.to).toContain(publicAudience);

		const renote = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { renoteId: older.id, noRelay: true }, user: author,
		})).createdNote;
		expect(renote.visibility).toBe('public');
		const apRenote = await simpleGet(`notes/${renote.id}/activity`, 'application/activity+json');
		expect(apRenote.status).toBe(200);
		expectHomeAudience(apRenote.body);
		await vi.waitFor(async () => {
			const sent = await deliveries(renote, 'Announce');
			expect(sent.map(job => job.to)).toEqual([followerInbox]);
			expectHomeAudience(sent[0].activity);
		}, 10000);
	}, 15000);

	test('keeps follower-only delivery private when relay opt-out is enabled', async () => {
		const note = (await successfulApiCall({
			endpoint: 'notes/create', parameters: { text: 'Followers only', visibility: 'followers', noRelay: true }, user: author,
		})).createdNote;
		expect(note.visibility).toBe('followers');
		await vi.waitFor(async () => {
			const sent = await deliveries(note, 'Create');
			expect(sent.map(job => job.to)).toEqual([followerInbox]);
			expect(sent[0].activity.to).toEqual([`${origin}/users/${author.id}/followers`]);
			expect(sent[0].activity.cc).not.toContain(publicAudience);
			expect(sent[0].activity.object.cc).not.toContain(publicAudience);
		}, 10000);
	}, 15000);
});
