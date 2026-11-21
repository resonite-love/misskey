/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { EntityManager, Repository } from 'typeorm';
import type { MiGridspacePlacement } from '@/models/GridspacePlacement.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiGridspaceNoteTombstone } from '@/models/Gridspace.js';
import { PlacementError } from '@/core/NotePlacementService.js';
import RemoveEndpoint, { meta as removeMeta } from '@/server/api/endpoints/gridspace/multi-note/remove.js';
import { meta as retryMeta } from '@/server/api/endpoints/gridspace/multi-note/retry.js';
import { GridspacePlacementService } from './GridspacePlacementService.js';
import { GridspaceLinkError } from './GridspaceLinkService.js';
import { previewHash, signPlacementProof, verifyPlacementProof, type PlacementProof } from './placement-protocol.js';

const peer = { origin: 'https://a.example', peerOrigin: 'https://b.example', secret: randomBytes(32), communityId: 'pair', keyId: 'key' };
const canonicalUri = peer.peerOrigin + '/notes/original';

test('read, reply and upload permissions are bound to the actor, target, purpose, revision and expiry', () => {
	const now = Date.now();
	const proof: PlacementProof = { actorUri: peer.origin + '/users/me', canonicalUri, channelOrigin: peer.peerOrigin, channelId: 'channel',
		placementId: '00000000-0000-4000-8000-000000000000', sourceRevision: 3, targetRevision: 4, expiresAt: now + 59_000, purpose: 'read', signature: '' };
	proof.signature = signPlacementProof(peer, proof);
	expect(verifyPlacementProof(peer, proof, proof.actorUri, canonicalUri, 'read', now)).toBe(true);
	for (const purpose of ['reply', 'upload'] as const) expect(verifyPlacementProof(peer, proof, proof.actorUri, canonicalUri, purpose, now)).toBe(false);
	expect(verifyPlacementProof(peer, proof, proof.actorUri, canonicalUri, 'read', proof.expiresAt)).toBe(false);
	expect(verifyPlacementProof(peer, { ...proof, targetRevision: 5 }, proof.actorUri, canonicalUri, 'read', now)).toBe(false);
	expect(verifyPlacementProof(peer, proof, peer.peerOrigin + '/users/me', canonicalUri, 'read', now)).toBe(false);
});

test('content preview hashes include poll choices and attachment metadata', () => {
	const base = { text: 'note', cw: 'cw', pollChoices: ['one', 'two'], files: [{ name: 'file', isSensitive: false }] };
	expect(previewHash(base)).toEqual(previewHash({ files: base.files, text: base.text, pollChoices: base.pollChoices, cw: base.cw }));
	expect(previewHash(base)).not.toEqual(previewHash({ ...base, pollChoices: ['one'] }));
	expect(previewHash(base)).not.toEqual(previewHash({ ...base, files: [{ ...base.files[0], isSensitive: true }] }));
});

function fixture() {
	const manager = mockDeep<EntityManager>();
	const repo = mockDeep<Repository<MiGridspacePlacement>>();
	manager.getRepository.mockReturnValue(repo);
	const transaction = vi.fn(async (write: (m: EntityManager) => Promise<unknown>) => write(manager));
	const db = { transaction, manager };
	const service = Object.assign(Object.create(GridspacePlacementService.prototype), { peer, db, config: { url: peer.origin } }) as GridspacePlacementService;
	return { manager, service, repo };
}

test('deletion before the first placement persists the same canonical tombstone as normal note import', async () => {
	const { manager, service, repo } = fixture();
	const key = { canonicalUri, channelId: 'channel', sourceRevision: 2 };
	repo.find.mockResolvedValue([]);
	expect((await service['receiveDelete'](key)).state).toBe('origin-deleted');
	expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['gridspace-note:' + canonicalUri]);
	expect(manager.upsert).toHaveBeenCalledWith(MiGridspaceNoteTombstone, { uri: canonicalUri }, ['uri']);
	manager.existsBy.mockResolvedValue(true);
	const later = await service['receivePlace']({ ...key, sourceRevision: 99, actorId: 'author', includeDefault: false, sortAt: new Date().toISOString() }, true);
	expect(later.state).toBe('origin-deleted');
	expect(repo.save).not.toHaveBeenCalled();
});

test('a destination removal remains terminal when a source sends a later revision', async () => {
	const { service, repo } = fixture();
	const row = { id: 'placement', channelId: 'ch', canonicalUri, state: 'removed', sourceRevision: 1, targetRevision: 2 };
	repo.findOneBy.mockResolvedValue(row as MiGridspacePlacement);
	repo.save.mockImplementation((async (x: MiGridspacePlacement) => x) as never);
	const status = await service['receivePlace']({ canonicalUri, channelId: 'ch', sourceRevision: 8, actorId: 'author', includeDefault: true, sortAt: new Date().toISOString() }, true);
	expect(status).toMatchObject({ state: 'removed', sourceRevision: 8, targetRevision: 2 });
});

test('only the original author or an origin moderator can retry unresolved deliveries on this server', async () => {
	const update = vi.fn();
	const findOneBy = vi.fn().mockResolvedValue({ id: 'original', userId: 'author' });
	const isModerator = vi.fn().mockResolvedValue(false);
	const service = Object.assign(Object.create(GridspacePlacementService.prototype), {
		config: { url: peer.origin }, db: { getRepository: () => ({ update, findOneBy }) }, roles: { isModerator },
		currentActorCredential: async () => true, peerEnabled: async () => true,
	}) as GridspacePlacementService;
	const localUri = peer.origin + '/notes/original';
	await expect(service.retry({ id: 'viewer' } as MiLocalUser, localUri)).rejects.toThrow('AUTHORIZATION_REVOKED');
	expect(update).not.toHaveBeenCalled();
	isModerator.mockResolvedValue(true);
	await service.retry({ id: 'moderator' } as MiLocalUser, localUri);
	expect(update).toHaveBeenCalledWith(expect.objectContaining({ canonicalUri: localUri, noteId: 'original', authorId: 'author', permanentFailure: false }), expect.objectContaining({ state: 'pending' }));
	await expect(service.retry({ id: 'moderator' } as MiLocalUser, canonicalUri)).rejects.toThrow('AUTHORIZATION_REVOKED');
	expect(update).toHaveBeenCalledTimes(1);
});

test('incoming placement policy errors remain typed and unknown transport errors are sanitized', async () => {
	const json = vi.fn();
	const service = Object.assign(Object.create(GridspacePlacementService.prototype), { peer, modules: { get: () => ({ json }) } }) as GridspacePlacementService;
	const input = { actorId: 'a', channelId: 'ch', includeDefault: false, preview: {}, hash: previewHash({}) };
	json.mockRejectedValueOnce(new GridspaceLinkError('CHANNEL_UNAVAILABLE'));
	await expect(service['call']('prepare', input)).rejects.toMatchObject({ code: 'CHANNEL_UNAVAILABLE' });
	json.mockRejectedValueOnce(new Error('internal transport detail'));
	await expect(service['call']('prepare', input)).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE', message: 'PEER_UNAVAILABLE' });
});

test('placement cleanup after a move is restricted and local removal errors become API errors', async () => {
	expect(removeMeta.prohibitMoved).toBe(true);
	expect(retryMeta.prohibitMoved).toBe(true);
	const placements = mockDeep<GridspacePlacementService>();
	const endpoint = new RemoveEndpoint(placements);
	for (const code of ['cannot-remove-placement', 'no-such-placement']) {
		placements.remove.mockRejectedValueOnce(new PlacementError(code));
		await expect(endpoint.exec({ canonicalUri, channelOrigin: peer.peerOrigin, channelId: 'channel' }, { id: 'viewer' } as MiLocalUser, null))
			.rejects.toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', info: { reason: code } });
	}
});
