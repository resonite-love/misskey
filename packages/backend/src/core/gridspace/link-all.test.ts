/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { UserFollowingService } from '@/core/UserFollowingService.js';
import type { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import type { IdService } from '@/core/IdService.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import type { MiGridspaceLink } from '@/models/Gridspace.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { GRIDSPACE_ALL_SCOPES, GRIDSPACE_CLIENT_PATH, GRIDSPACE_PRIVATE_CLIENT_PATH, GRIDSPACE_LINK_SCOPES, gridspaceHash } from './link-crypto.js';
import { GRIDSPACE_PALETTE_SCOPE } from './palette-protocol.js';

function setup() {
	const db = mockDeep<DataSource>();
	const guard = mockDeep<GridspaceFollowGuardService>();
	guard.run.mockImplementation(async (_id, action) => action());
	const service = new GridspaceLinkService({ url: 'https://g.example' } as Config, db, mockDeep<UserFollowingService>(), mockDeep<ApPersonService>(), guard, mockDeep<IdService>());
	service['peer'] = { origin: 'https://g.example', peerOrigin: 'https://r.example', communityId: 'test', keyId: 'test', secret: Buffer.alloc(32, 7) };
	return { service, db };
}

test('a new link requests all bridge scopes in one PKCE authorization without requiring an existing link', async () => {
	const { service, db } = setup();
	const insert = vi.fn();
	db.getRepository.mockReturnValue({ delete: vi.fn(), insert } as never);
	const privateLink = vi.spyOn(service, 'privateLink');
	const result = await service.start({ id: 'user' } as MiLocalUser);
	const url = new URL(result.authorizationUrl);
	expect(url.searchParams.get('scope')?.split(' ')).toEqual(GRIDSPACE_ALL_SCOPES);
	expect(url.searchParams.get('client_id')).toBe('https://g.example' + GRIDSPACE_CLIENT_PATH);
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(insert.mock.calls[0][0]).toMatchObject({ purpose: 'link-all', localUserId: 'user', linkId: null });
	expect(privateLink).not.toHaveBeenCalled();
});

test.each([GRIDSPACE_CLIENT_PATH, GRIDSPACE_PRIVATE_CLIENT_PATH])('peer credentials cannot use the general private API: %s', path => {
	const { service } = setup();
	expect(() => service.assertPrivateCaller({ name: 'https://r.example' + path } as MiAccessToken)).toThrow('AUTHORIZATION_REVOKED');
	expect(() => service.assertPrivateCaller(null)).not.toThrow();
});

test.each([GRIDSPACE_CLIENT_PATH, GRIDSPACE_PRIVATE_CLIENT_PATH])('revoking a bound token removes private access but preserves combined link scopes: %s', async path => {
	const { service } = setup();
	const manager = mockDeep<EntityManager>();
	const token = { id: 'bound', token: 'secret', name: 'https://r.example' + path, permission: GRIDSPACE_ALL_SCOPES };
	const update = vi.fn();
	const remove = vi.fn();
	manager.getRepository.mockReturnValue({ find: vi.fn().mockResolvedValue([token, { ...token, id: 'unrelated', token: 'other' }]), update, delete: remove } as never);
	const link = { localUserId: 'user', privateTokenHash: gridspaceHash(token.token) } as MiGridspaceLink;
	await service['deletePrivateBinding'](manager, link);
	if (path === GRIDSPACE_CLIENT_PATH) {
		expect(update).toHaveBeenCalledExactlyOnceWith('bound', { permission: [...GRIDSPACE_LINK_SCOPES, GRIDSPACE_PALETTE_SCOPE] });
		expect(remove).not.toHaveBeenCalled();
	} else {
		expect(remove).toHaveBeenCalledExactlyOnceWith('bound');
		expect(update).not.toHaveBeenCalled();
	}
});
