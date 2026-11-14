/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { MiUser } from '@/models/User.js';
import { MiFollowing } from '@/models/Following.js';
import { MiFollowRequest } from '@/models/FollowRequest.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiMuting } from '@/models/Muting.js';
import { MiGridspaceFollowExpansion, MiGridspaceFollowOverride, MiGridspaceLink } from '@/models/Gridspace.js';
import type { UserFollowingService } from '@/core/UserFollowingService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { GridspaceFollowExpansionService } from './GridspaceFollowExpansionService.js';
import { sealGridspaceSecret } from './link-crypto.js';
import { resolveGridspaceConfig } from './peer-protocol.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';

afterEach(() => vi.unstubAllEnvs());

function fixture(sourceSide = false) {
	vi.stubEnv('GRIDSPACE_EXPANSION_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const config = { url: 'https://g.example', gridspace: { enabled: true, communityId: 'test', peerUrl: 'https://r.example', keyId: 'test', secretEnv: 'GRIDSPACE_EXPANSION_TEST_KEY' } } as Config;
	const peer = resolveGridspaceConfig(config.gridspace, config.url, process.env)!;
	if (sourceSide) config.gridspace!.channelRole = 'source';
	const db = mockDeep<DataSource>();
	const following = mockDeep<UserFollowingService>();
	const links = mockDeep<GridspaceLinkService>();
	links.json.mockResolvedValue({ ready: true });
	const guard = mockDeep<GridspaceFollowGuardService>();
	guard.runMany.mockImplementation(async (_, action) => action());
	const row = { state: 'pending', retryAt: new Date(0), attempts: 0 } as MiGridspaceFollowExpansion;
	let hasRow = false;
	const receipts = {
		findOneBy: vi.fn(async () => hasRow ? row : null),
		upsert: vi.fn(async value => { hasRow = true; Object.assign(row, value); }),
		update: vi.fn(async (_, value) => { Object.assign(row, value); }),
	};
	const source = { id: 'source', host: sourceSide ? null : 'r.example', uri: sourceSide ? null : 'https://r.example/users/old-target' } as MiUser;
	const user = { id: 'viewer', host: null } as MiUser;
	const target = { id: 'target', host: sourceSide ? 'r.example' : null, uri: sourceSide ? 'https://r.example/users/new-target' : null } as MiUser;
	const users = { findOneBy: vi.fn(async ({ id, uri }) => uri ? target : ({ viewer: user, target, source })[id as 'viewer' | 'target' | 'source']) };
	const tokens = new Map(['viewer', 'target'].map(id => [id, sealGridspaceSecret(peer, `token-${id}`, id)]));
	const binding = (id: string) => ({ id, localUserId: id, generation: 1, peerUserId: sourceSide ? 'new-target' : 'old-target', tokenCipher: sourceSide ? null : tokens.get(id) });
	const bindings = { findOneBy: vi.fn(async ({ localUserId }) => binding(localUserId)) };
	const subscriptions = { findOneBy: vi.fn(async () => ({ withReplies: true })), existsBy: vi.fn(async () => false) };
	const requests = { findOneBy: vi.fn(async () => null as { withReplies: boolean } | null), existsBy: vi.fn(async () => false) };
	const overrides = { existsBy: vi.fn(async () => false) };
	const blocks = { exists: vi.fn(async () => false) };
	const mutes = { findBy: vi.fn(async () => [] as { expiresAt: Date | null }[]) };
	const repositories = new Map<unknown, unknown>([
		[MiGridspaceFollowExpansion, receipts], [MiGridspaceLink, bindings], [MiUser, users], [MiFollowing, subscriptions],
		[MiFollowRequest, requests], [MiGridspaceFollowOverride, overrides], [MiBlocking, blocks], [MiMuting, mutes],
	]);
	db.getRepository.mockImplementation(entity => repositories.get(entity) as never);
	const history = mockDeep<GridspaceHistoryService>(); history.verifyLink.mockResolvedValue(true);
	const people = mockDeep<ApPersonService>(); people.resolvePerson.mockResolvedValue(target as never);
	const service = new GridspaceFollowExpansionService(config, db, following, links, guard, history, people);
	const run = () => sourceSide ? service['expandSource']({ followerId: user.id, sourceId: source.id, linkId: source.id, generation: 1 }) : service['expand']({ followerId: user.id, targetId: target.id, sourceId: source.id });
	return { run, row, following, links, guard, subscriptions, requests, overrides, blocks, mutes, target, bindings, user, users, history, people };
}

describe('linked-account follow expansion', () => {
	test.each(['readiness', 'profile'] as const)('backs off failed source %s requests across candidates', async failure => {
		const f = fixture(true);
		if (failure === 'readiness') f.links.json.mockRejectedValue(new Error('offline'));
		else f.people.updatePerson.mockRejectedValue(new Error('offline'));
		await f.run(); await f.run();
		expect(f.links.json).toHaveBeenCalledOnce();
		expect(f.following.follow).not.toHaveBeenCalled();
		if (failure === 'profile') expect(f.people.updatePerson).toHaveBeenCalledOnce();
	});
	test('prepares both profiles before taking following locks', async () => {
		const f = fixture(); let locked = false;
		f.guard.runMany.mockImplementation(async (_, action) => { locked = true; try { return await action(); } finally { locked = false; } });
		f.links.ensureProfileBeforeFollowing.mockImplementation(async () => { expect(locked).toBe(false); });
		await f.run();
		expect(f.links.ensureProfileBeforeFollowing).toHaveBeenCalledTimes(2);
		expect(f.following.follow).toHaveBeenCalledOnce();
	});
	test('source expansion waits for the new profile before resolving or following the destination', async () => {
		vi.useFakeTimers();
		try {
			const f = fixture(true); f.links.json.mockResolvedValueOnce({ ready: false });
			await f.run();
			expect(f.people.resolvePerson).not.toHaveBeenCalled(); expect(f.people.updatePerson).not.toHaveBeenCalled();
			expect(f.following.follow).not.toHaveBeenCalled();
			vi.advanceTimersByTime(30001); await f.run();
			expect(f.people.updatePerson).toHaveBeenCalledWith(f.target.uri);
			expect(f.people.updatePerson.mock.invocationCallOrder[0]).toBeLessThan(f.following.follow.mock.invocationCallOrder[0]);
		} finally { vi.useRealTimers(); }
	});
	test('destination expansion leaves follows pending when either profile has not completed', async () => {
		const f = fixture(); f.links.ensureProfileBeforeFollowing.mockRejectedValueOnce(new Error('pending'));
		await f.run(); expect(f.following.follow).not.toHaveBeenCalled(); expect(f.row.state).toBe('pending');
		f.row.retryAt = new Date(0); await f.run(); expect(f.following.follow).toHaveBeenCalledOnce();
	});
	test('source followers need no link or OAuth token and follow the verified remote counterpart once', async () => {
		const f = fixture(true);
		await f.run(); await f.run();
		expect(f.following.follow).toHaveBeenCalledExactlyOnceWith(f.user, f.target, { withReplies: true });
		expect(f.bindings.findOneBy).toHaveBeenCalledWith(expect.objectContaining({ localUserId: 'source', initiator: false }));
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/link/profile-ready', expect.objectContaining({ localUserId: 'source' }));
		expect(f.history.verifyLink).toHaveBeenCalledOnce();
	});
	test.each(['override', 'block', 'mute', 'suspended', 'existing', 'no-source-follow'] as const)('source expansion respects %s', async reason => {
		const f = fixture(true);
		if (reason === 'override') f.overrides.existsBy.mockResolvedValue(true);
		if (reason === 'block') f.blocks.exists.mockResolvedValue(true);
		if (reason === 'mute') f.mutes.findBy.mockResolvedValue([{ expiresAt: null }]);
		if (reason === 'suspended') f.target.isSuspended = true;
		if (reason === 'existing') f.requests.existsBy.mockResolvedValue(true);
		if (reason === 'no-source-follow') f.subscriptions.findOneBy.mockResolvedValue(null as never);
		await f.run(); expect(f.following.follow).not.toHaveBeenCalled();
	});
	test('source expansion retries remote verification failures, preserving locked account approval', async () => {
		const f = fixture(true); f.target.isLocked = true;
		f.history.verifyLink.mockResolvedValueOnce(false);
		await f.run(); expect(f.following.follow).not.toHaveBeenCalled(); expect(f.row.state).toBe('pending');
		f.row.retryAt = new Date(0); await f.run();
		expect(f.following.follow).toHaveBeenCalledExactlyOnceWith(f.user, f.target, { withReplies: true });
	});
	test('source remote actor failures back off before retrying resolution', async () => {
		const f = fixture(true);
		f.users.findOneBy.mockImplementation(async ({ id, uri }) => uri ? null as never : id === 'viewer' ? f.user : { id: 'source', host: null } as MiUser);
		f.people.resolvePerson.mockRejectedValue(new Error('offline'));
		await f.run(); await f.run();
		expect(f.people.resolvePerson).toHaveBeenCalledOnce(); expect(f.following.follow).not.toHaveBeenCalled();
	});
	test('uses ordinary follow once with replies and validates both peer bindings', async () => {
		const f = fixture();
		await f.run(); await f.run();
		expect(f.following.follow).toHaveBeenCalledExactlyOnceWith(f.user, f.target, { withReplies: true });
		expect(f.links.json).toHaveBeenCalledTimes(2);
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/link/check', expect.objectContaining({ accessToken: 'token-target' }));
		expect(f.guard.runMany).toHaveBeenCalledWith(['viewer', 'target'], expect.any(Function));
		expect(f.row.state).toBe('done');
	});
	test('includes pending source subscriptions without bypassing normal target approval', async () => {
		const f = fixture(); f.subscriptions.findOneBy.mockResolvedValue(null as never); f.requests.findOneBy.mockResolvedValue({ withReplies: false }); f.target.isLocked = true;
		await f.run();
		expect(f.following.follow).toHaveBeenCalledExactlyOnceWith(f.user, f.target, { withReplies: false });
	});
	test('does not restore manual cancellation or rejection, even after a lost receipt', async () => {
		const f = fixture(); f.overrides.existsBy.mockResolvedValue(true);
		await f.run();
		expect(f.following.follow).not.toHaveBeenCalled(); expect(f.row.reason).toBe('USER_UNFOLLOWED');
	});
	test('does not modify an existing follow or request', async () => {
		const f = fixture(); f.requests.existsBy.mockResolvedValue(true);
		await f.run();
		expect(f.following.follow).not.toHaveBeenCalled(); expect(f.row.state).toBe('done');
	});
	test.each(['block', 'mute', 'suspended', 'moved'] as const)('skips a restricted account: %s', async kind => {
		const f = fixture();
		if (kind === 'block') f.blocks.exists.mockResolvedValue(true);
		if (kind === 'mute') f.mutes.findBy.mockResolvedValue([{ expiresAt: null }]);
		if (kind === 'suspended') f.target.isSuspended = true;
		if (kind === 'moved') f.target.movedToUri = 'https://elsewhere.example/actor';
		await f.run(); expect(f.following.follow).not.toHaveBeenCalled(); expect(f.row.reason).toBe('TARGET_RESTRICTED');
	});
	test('allows an expired mute', async () => {
		const f = fixture(); f.mutes.findBy.mockResolvedValue([{ expiresAt: new Date(0) }]);
		await f.run(); expect(f.following.follow).toHaveBeenCalledOnce();
	});
	test('stops if the source follow or local binding vanished while queued', async () => {
		const f = fixture(); f.subscriptions.findOneBy.mockResolvedValue(null as never);
		await f.run(); expect(f.following.follow).not.toHaveBeenCalled();
		const other = fixture(); other.bindings.findOneBy.mockResolvedValue(null as never);
		await other.run(); expect(other.following.follow).not.toHaveBeenCalled();
	});
	test('backs off after a peer failure and retries without writing prematurely', async () => {
		const f = fixture(); f.links.json.mockRejectedValueOnce(new Error('outage'));
		await f.run(); expect(f.following.follow).not.toHaveBeenCalled();
		expect(f.row).toMatchObject({ state: 'pending', attempts: 1, reason: 'FOLLOW_FAILED' });
		expect(f.row.retryAt.getTime()).toBeGreaterThan(Date.now());
		await f.run(); expect(f.links.json).toHaveBeenCalledOnce();
		f.row.retryAt = new Date(0); await f.run();
		expect(f.following.follow).toHaveBeenCalledOnce(); expect(f.row.state).toBe('done');
	});
});
