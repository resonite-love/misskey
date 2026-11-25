/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { EntityManager } from 'typeorm';
import { NoteCreateService } from './NoteCreateService.js';
import { NotePlacementService } from './NotePlacementService.js';
import { MiNote } from '@/models/Note.js';
import { MiChannel } from '@/models/Channel.js';
import { GridspacePlacementService } from '@/core/gridspace/GridspacePlacementService.js';
import { MiUser } from '@/models/User.js';
import { MiPoll } from '@/models/Poll.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import type { MiLocalUser } from '@/models/User.js';

const user = { id: 'viewer' } as MiLocalUser;
const original = { id: 'original', userId: 'author', visibility: 'public', channelId: null, includeDefault: null, text: 'Original', fileIds: [], renoteId: null } as unknown as MiNote;
const input = { createdAt: new Date(), fileIds: [], text: null, cw: null, replyId: null, renoteId: original.id, visibility: 'public', visibleUserIds: [], channelId: null,
	multiNote: { includeDefault: false, channelIds: [], channelTargets: [{ origin: 'https://peer.test', channelId: 'peer-channel' }], clientRequestId: 'request', inputHash: 'hash' } };
let current: MiNote | null;
const manager = mockDeep<EntityManager>();
let placements: NotePlacementService;

beforeEach(() => {
	vi.clearAllMocks();
	current = { ...original };
	manager.findOne.mockImplementation((async entity => entity === MiNote ? current : entity === MiChannel ? { isArchived: false, allowRenoteToExternal: true } : null) as EntityManager['findOne']);
	placements = Object.assign(Object.create(NotePlacementService.prototype), { readable: vi.fn(async () => current), db: { manager } });
});

function fixture() {
	const create = vi.fn(async (_user, data) => data);
	const service = Object.assign(Object.create(NoteCreateService.prototype), {
		notePlacementService: Object.assign(placements, { status: vi.fn(async () => ({ status: 'missing', note: null })) }),
		notesRepository: { findOne: vi.fn(async () => current) }, blockingsRepository: { exists: async () => false },
	});
	Object.defineProperty(service, 'create', { value: create });
	return { service: service as NoteCreateService, create };
}

test('a native note can be renoted to one peer channel, locally, with an insertion-time authorization check', async () => {
	const f = fixture();
	await f.service.fetchAndCreate(user, input);
	const data = f.create.mock.calls[0][1];
	expect(data).toMatchObject({ renote: original, multiNote: input.multiNote, localOnly: true });
	await data.placedRenoteCheck(manager);
	expect(manager.findOne).toHaveBeenCalledWith(MiNote, { where: { id: 'original' }, lock: { mode: 'pessimistic_read' } });
	current = null;
	await expect(data.placedRenoteCheck(manager)).rejects.toThrow('renote-source-unavailable');
});

test.each([
	{ includeDefault: true }, { channelIds: ['local'] }, { channelTargets: [] },
	{ channelTargets: [{ origin: 'https://peer.test', channelId: 'one' }, { origin: 'https://peer.test', channelId: 'two' }] },
])('rejects mixed or multiple destinations for a native renote (%j)', async patch => {
	const f = fixture();
	await expect(f.service.fetchAndCreate(user, { ...input, multiNote: { ...input.multiNote, ...patch } })).rejects.toThrow('incompatible-destination');
	expect(f.create).not.toHaveBeenCalled();
});

test.each([{ visibility: 'followers' }, { visibility: 'specified' }, { includeDefault: false }, { renoteId: 'parent', text: null }])('does not export restricted or pure-renote sources (%j)', async patch => {
	current = { ...original, ...patch } as MiNote;
	await expect(placements.authorizeRenote(user.id, original.id, manager)).rejects.toThrow('renote-source-unavailable');
});

test.each([{ isArchived: true, allowRenoteToExternal: true }, { isArchived: false, allowRenoteToExternal: false }])('rechecks legacy channel export under a lock (%j)', async channel => {
	current = { ...original, channelId: 'source-channel' };
	manager.findOne.mockImplementation((async entity => entity === MiNote ? current : channel) as EntityManager['findOne']);
	await expect(placements.authorizeRenote(user.id, original.id, manager)).rejects.toThrow('channel-disallows-external-renotes');
	expect(manager.findOne).toHaveBeenCalledWith(MiChannel, { where: { id: 'source-channel' }, lock: { mode: 'for_no_key_update' } });
});

test('legacy channel sources can be exported when their current channel permits it', async () => {
	current = { ...original, includeDefault: false, channelId: 'source-channel' };
	await expect(placements.authorizeRenote(user.id, original.id, manager)).resolves.toBe(current);
});

test('replays an existing receipt before consulting source or peer availability', async () => {
	const f = fixture();
	vi.mocked(f.service['notePlacementService'].status).mockResolvedValue({ status: 'created', note: { id: 'existing' } as MiNote });
	expect(await f.service.fetchAndCreate(user, input)).toMatchObject({ id: 'existing' });
	expect(f.create).not.toHaveBeenCalled();
});

test('peer delivery moderates the referenced text, poll and files and rechecks the source', async () => {
	const note = { id: 'wrapper', text: null, cw: null, fileIds: [], renoteId: original.id };
	const target = { ...original, cw: 'warning', hasPoll: true, fileIds: ['file'] };
	const authorize = vi.fn(async () => target);
	const service = Object.assign(Object.create(GridspacePlacementService.prototype), {
		db: { getRepository: (entity: unknown) => entity === MiNote ? { findOneBy: async () => note } : entity === MiUser ? { findOneBy: async () => user }
			: entity === MiPoll ? { findOneBy: async () => ({ choices: ['choice'] }) } : entity === MiDriveFile ? { findBy: async () => [{ id: 'file', name: 'image', isSensitive: true }] } : null },
		currentActorCredential: async () => ({}), modules: { get: () => ({ authorizeRenote: authorize }) },
	}) as GridspacePlacementService;
	const row = { noteId: 'wrapper', authorId: user.id } as Parameters<GridspacePlacementService['sourcePreview']>[0];
	expect(await service['sourcePreview'](row)).toMatchObject({ text: 'Original', cw: 'warning', pollChoices: ['choice'], files: [{ name: 'image', isSensitive: true }] });
	authorize.mockRejectedValue(new Error('source revoked'));
	await expect(service['sourcePreview'](row)).rejects.toThrow('source revoked');
});
