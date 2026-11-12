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

afterEach(() => vi.unstubAllEnvs());

function fixture() {
	vi.stubEnv('GRIDSPACE_EXPANSION_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const config = { url: 'https://g.example', gridspace: { enabled: true, communityId: 'test', peerUrl: 'https://r.example', keyId: 'test', secretEnv: 'GRIDSPACE_EXPANSION_TEST_KEY' } } as Config;
	const peer = resolveGridspaceConfig(config.gridspace, config.url, process.env)!;
	const db = mockDeep<DataSource>();
	const following = mockDeep<UserFollowingService>();
	const links = mockDeep<GridspaceLinkService>();
	const guard = mockDeep<GridspaceFollowGuardService>();
	guard.runMany.mockImplementation(async (_, action) => action());
	const row = { state: 'pending', retryAt: new Date(0), attempts: 0 } as MiGridspaceFollowExpansion;
	let hasRow = false;
	const receipts = {
		findOneBy: vi.fn(async () => hasRow ? row : null),
		upsert: vi.fn(async value => { hasRow = true; Object.assign(row, value); }),
		update: vi.fn(async (_, value) => { Object.assign(row, value); }),
	};
	const source = { id: 'source', host: 'r.example', uri: 'https://r.example/users/old-target' } as MiUser;
	const user = { id: 'viewer', host: null } as MiUser;
	const target = { id: 'target', host: null } as MiUser;
	const users = { findOneBy: vi.fn(async ({ id }) => ({ viewer: user, target, source })[id as 'viewer' | 'target' | 'source']) };
	const binding = (id: string) => ({ id, localUserId: id, generation: 1, peerUserId: 'old-target', tokenCipher: sealGridspaceSecret(peer, `token-${id}`, id) });
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
	const service = new GridspaceFollowExpansionService(config, db, following, links, guard);
	const run = () => service['expand']({ followerId: user.id, targetId: target.id, sourceId: source.id });
	return { run, row, following, links, guard, subscriptions, requests, overrides, blocks, mutes, target, bindings, user };
}

describe('linked-account follow expansion', () => {
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
