/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { entities } from '@/postgres.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser } from '@/models/User.js';
import { MiFollowing } from '@/models/Following.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiGridspaceFollowDecision } from '@/models/Gridspace.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { QueueService } from '@/core/QueueService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { IdService } from '@/core/IdService.js';
import { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';

// Explicit opt-in: never touch the normal unit database or a production configuration.
describe.runIf(process.env.GRIDSPACE_DECISION_LAB === '1')('delegated follow decisions on the isolated lab database', () => {
	let db: DataSource; let module: TestingModule; let guard: GridspaceFollowGuardService; let service: UserFollowingService;
	let followee: MiUser; let follower: MiUser; let requestId: string;
	const queue = mockDeep<QueueService>(); const users = mockDeep<UserEntityService>(); const renderer = mockDeep<ApRendererService>();
	const suffix = randomBytes(5).toString('hex'); const gen = () => randomBytes(12).toString('hex');
	beforeAll(async () => {
		const root = resolve('../..');
		const config = JSON.parse(readFileSync(resolve(root, '.config/gridspace-lab.yml'), 'utf8')) as Config;
		expect([config.url, config.port, config.db.host, config.db.port, config.db.db]).toEqual(['https://grid-space-misskey.kokopi.me', 13000, '127.0.0.1', 15432, 'misskey']);
		config.db.pass = readFileSync(resolve(root, '.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)![1].trim();
		db = await new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db, entities, synchronize: false, dropSchema: false }).initialize();
		const admin = JSON.parse(readFileSync(resolve(root, '.config/gridspace-lab-accounts.json'), 'utf8')).accounts.admin.token;
		const make = async (name: string) => {
			const response = await fetch(`${config.url}/api/admin/accounts/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: admin, username: `dc_${name}_${suffix}`, password: randomBytes(24).toString('hex') }) });
			const result = await response.json(); expect({ status: response.status, code: result?.error?.code }).toEqual({ status: 200, code: undefined }); const account = result as { id: string };
			return db.getRepository(MiUser).findOneByOrFail({ id: account.id });
		};
		followee = await make('target'); follower = await make('remote');
		await db.getRepository(MiUser).update(follower.id, { host: 'external.example', uri: `https://external.example/users/${follower.id}`, inbox: 'https://external.example/inbox' });
		follower = await db.getRepository(MiUser).findOneByOrFail({ id: follower.id });
		guard = new GridspaceFollowGuardService(db, config);
		users.isRemoteUser.mockImplementation((user => user.host !== null) as UserEntityService['isRemoteUser']);
		users.isLocalUser.mockImplementation((user => user.host === null) as UserEntityService['isLocalUser']);
		renderer.renderFollow.mockImplementation((actor, target, id) => ({ type: 'Follow', actor: actor.uri!, object: `${config.url}/users/${target.id}`, id }));
		renderer.renderAccept.mockImplementation((object, target) => ({ type: 'Accept', actor: `${config.url}/users/${target.id}`, object }));
		renderer.renderReject.mockImplementation((object, target) => ({ type: 'Reject', actor: `${config.url}/users/${target.id}`, object }));
		renderer.addContext.mockImplementation((value => value) as ApRendererService['addContext']);
		module = await Test.createTestingModule({ providers: [UserFollowingService,
			{ provide: DI.config, useValue: config }, { provide: DI.usersRepository, useValue: db.getRepository(MiUser) },
			{ provide: DI.followingsRepository, useValue: db.getRepository(MiFollowing) }, { provide: DI.followRequestsRepository, useValue: db.getRepository(MiFollowRequest) },
			{ provide: GridspaceFollowGuardService, useValue: guard }, { provide: UserEntityService, useValue: users }, { provide: QueueService, useValue: queue },
			{ provide: ApRendererService, useValue: renderer }, { provide: IdService, useValue: { gen } },
		] }).useMocker(() => mockDeep()).compile();
		service = module.get(UserFollowingService);
	});
	beforeEach(async () => {
		queue.deliver.mockReset(); queue.deliver.mockResolvedValue(null as never);
		await db.getRepository(MiFollowing).delete({ followerId: follower.id });
		await db.getRepository(MiFollowRequest).delete({ followerId: follower.id });
		await db.getRepository(MiGridspaceFollowDecision).delete({ followerId: follower.id });
		await db.getRepository(MiBlocking).delete({ blockerId: followee.id });
		await db.getRepository(MiUser).update(follower.id, { followingCount: 0 });
		await db.getRepository(MiUser).update(followee.id, { followersCount: 0 });
		requestId = gen();
		await db.getRepository(MiFollowRequest).insert({ id: requestId, followerId: follower.id, followeeId: followee.id, requestId: `https://external.example/follows/${requestId}`, withReplies: true });
	});
	afterAll(async () => {
		if (db?.isInitialized && follower && followee) {
			await db.getRepository(MiGridspaceFollowDecision).delete({ followerId: follower.id });
			await db.getRepository(MiUser).delete([follower.id, followee.id]);
		}
		if (module) await module.close(); else await guard?.onApplicationShutdown(); if (db?.isInitialized) await db.destroy();
	});
	const decide = (accept = true, authorize = async () => {}) => service.decideAuthorizedFollowRequest(followee.id, follower.id, requestId, accept, authorize);
	test('commits once and retries AP after queue failure even if UI publication also fails', async () => {
		queue.deliver.mockRejectedValueOnce(new Error('queue offline'));
		await expect(decide()).rejects.toThrow('queue offline');
		expect(await db.getRepository(MiFollowing).countBy({ followerId: follower.id })).toBe(1);
		expect(await db.getRepository(MiFollowRequest).countBy({ followerId: follower.id })).toBe(0);
		expect((await db.getRepository(MiGridspaceFollowDecision).findOneByOrFail({ requestId })).delivered).toBe(false);
		await service.flushFollowDecisions();
		expect((await db.getRepository(MiGridspaceFollowDecision).findOneByOrFail({ requestId })).delivered).toBe(true);
		expect(queue.deliver).toHaveBeenCalledTimes(2);
		await expect(decide()).resolves.toBe(true);
		expect(queue.deliver).toHaveBeenCalledTimes(2);
		expect((await db.getRepository(MiUser).findOneByOrFail({ id: follower.id })).followingCount).toBe(1);
		await expect(decide(false)).rejects.toMatchObject({ id: 'gridspace-follow-decision-rejected' });
	});
	test('does not replay an old Reject after a fresh request', async () => {
		queue.deliver.mockRejectedValueOnce(new Error('queue offline')); await expect(decide(false)).rejects.toThrow();
		await db.getRepository(MiFollowRequest).insert({ id: gen(), followerId: follower.id, followeeId: followee.id });
		await service.flushFollowDecisions(); expect(queue.deliver).toHaveBeenCalledTimes(1);
		expect((await db.getRepository(MiGridspaceFollowDecision).findOneByOrFail({ requestId })).delivered).toBe(true);
	});
	test('does not replay Accept after that following is removed', async () => {
		queue.deliver.mockRejectedValueOnce(new Error('queue offline')); await expect(decide()).rejects.toThrow();
		await db.getRepository(MiFollowing).delete({ followerId: follower.id });
		await service.flushFollowDecisions(); expect(queue.deliver).toHaveBeenCalledTimes(1);
	});
	test('concurrent approvals update counters once and recheck authorization after lock wait', async () => {
		const decisions = await Promise.all([decide(), decide()]); expect(decisions).toEqual([true, true]);
		expect((await db.getRepository(MiUser).findOneByOrFail({ id: followee.id })).followersCount).toBe(1);
		expect(queue.deliver).toHaveBeenCalledTimes(1);
		await expect(decide(true, async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
	});
	test('a block committed under the pair guard prevents approval', async () => {
		await guard.runDecisionPair(followee.id, follower.id, async () => {
			await db.getRepository(MiBlocking).insert({ id: gen(), blockerId: followee.id, blockeeId: follower.id });
		});
		await expect(decide()).rejects.toMatchObject({ id: 'gridspace-follow-decision-rejected' });
		expect(await db.getRepository(MiFollowing).countBy({ followerId: follower.id })).toBe(0);
		expect(queue.deliver).not.toHaveBeenCalled();
	});
});
