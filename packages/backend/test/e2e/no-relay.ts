/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { entities } from 'misskey-js';
import { loadConfig } from '@/config.js';
import { MiFollowing } from '@/models/Following.js';
import { MiRelay } from '@/models/Relay.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import { api, initTestDb, signup, successfulApiCall } from '../utils.js';

describe('Per-note relay delivery', () => {
	const followerInbox = 'https://follower.example/inbox';
	const relayInboxes = ['https://first-relay.example/inbox', 'https://second-relay.example/inbox'];
	const normalInboxes = [followerInbox, ...relayInboxes].sort();

	let db: DataSource;
	let author: entities.SignupResponse;
	let voter: entities.SignupResponse;
	let queue: Queue<{ to: string; content: string }>;

	beforeAll(async () => {
		db = await initTestDb(true);
		await signup({ username: 'root' });
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

	async function recipients(note: entities.Note, activityType: string) {
		const jobs = await queue.getJobs(['waiting', 'paused'], 0, -1);
		return jobs.filter(job => job.data.content.includes(`/notes/${note.id}`) && JSON.parse(job.data.content).type === activityType)
			.map(job => job.data.to).sort();
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
		expect(await recipients(local, 'Create')).toEqual([]);
	}, 20000);
});
