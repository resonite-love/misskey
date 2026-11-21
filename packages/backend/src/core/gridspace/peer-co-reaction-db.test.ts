/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { loadConfig } from '@/config.js';
import { entities } from '@/postgres.js';
import { MiNoteReaction } from '@/models/NoteReaction.js';
import { MiExtendedNoteReaction } from '@/models/ExtendedNoteReaction.js';
import { MiUser, type MiRemoteUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import { MiEmoji } from '@/models/Emoji.js';
import type { EmojisRepository, MiMeta } from '@/models/_.js';
import { ReactionService } from '@/core/ReactionService.js';
import { ExtendedReactionService } from '@/core/ExtendedReactionService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { IdService } from '@/core/IdService.js';
import type { UserBlockingService } from '@/core/UserBlockingService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceReactionDeliveryService } from './GridspaceReactionDeliveryService.js';
import type { GridspacePlacementActionService } from './GridspacePlacementActionService.js';
import { GridspaceActionService } from './GridspaceActionService.js';

const config = loadConfig();
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user,
	password: config.db.pass, database: config.db.db, entities, installExtensions: false });
let runner: QueryRunner;

beforeAll(async () => {
	await db.initialize();
	runner = db.createQueryRunner();
	await runner.connect();
	await runner.query('CREATE TEMP TABLE note_reaction (id varchar PRIMARY KEY, "userId" varchar, "noteId" varchar, reaction varchar, UNIQUE ("userId", "noteId"))');
	await runner.query('CREATE TEMP TABLE extended_note_reaction (LIKE note_reaction INCLUDING DEFAULTS, UNIQUE ("userId", "noteId", reaction))');
});
beforeEach(async () => { await runner.query('TRUNCATE note_reaction, extended_note_reaction'); });
afterAll(async () => { await runner?.release(); if (db.isInitialized) await db.destroy(); });

function fixture(route: 'linked' | 'guest' | 'placement') {
	const manager = runner.manager;
	const actor = { id: 'viewer', host: route === 'linked' ? null : 'viewer.test', isBot: false } as MiUser;
	const note = { id: 'target', userId: 'author', userHost: null, renoteId: null, renoteUserHost: null, uri: null, localOnly: true,
		channelId: route === 'placement' ? null : 'channel', multiNoteKind: route === 'placement' ? 'root' : null, includeDefault: false, reactionAndUserPairCache: [] } as unknown as MiNote;
	const emoji: MiEmoji = Object.assign(new MiEmoji(), { name: 'cat', host: null, roleIdsThatCanBeUsedThisEmojiAsReaction: [], localOnly: false, isSensitive: false });
	const emojis = mockDeep<CustomEmojiService>();
	emojis.localEmojisCache.fetch.mockResolvedValue(new Map([['cat', emoji]]));
	const remote = mockDeep<EmojisRepository>();
	remote.findOneBy.mockResolvedValue({ ...emoji, host: 'viewer.test' });
	const utility = mockDeep<UtilityService>(); utility.toPunyNullable.mockImplementation(host => host ?? null);
	const roles = mockDeep<RoleService>(); roles.getUserRoles.mockResolvedValue([]);
	const blocking = mockDeep<UserBlockingService>(); blocking.checkBlocked.mockResolvedValue(false);
	const visibility = mockDeep<NoteEntityService>(); visibility.isVisibleForMe.mockResolvedValue(true);
	const ids = mockDeep<IdService>(); ids.gen.mockReturnValue('new'); ids.parse.mockReturnValue({ date: new Date(0) });
	const delivery = mockDeep<GridspaceReactionDeliveryService>(); delivery.mutate.mockImplementation(async (_note, write) => write(manager));
	const reactions = new ReactionService(mockDeep(), mockDeep<MiMeta>({ enableReactionsBuffering: true }),
		mockDeep(), mockDeep(), mockDeep(), remote, utility, emojis, roles, mockDeep(), visibility, blocking,
		mockDeep(), ids, mockDeep(), mockDeep(), mockDeep(), mockDeep(), mockDeep(), mockDeep(), delivery, mockDeep());
	vi.spyOn(reactions, 'withReactionLock').mockImplementation(async (_user, _note, work) => work());
	const sourceDb = mockDeep<DataSource>();
	sourceDb.getRepository.mockImplementation(target => target === MiUser ? { findOneBy: async () => actor } as never : manager.getRepository(target));
	sourceDb.transaction.mockImplementation((async (callback: (m: EntityManager) => Promise<unknown>) => manager.transaction(callback)) as DataSource['transaction']);
	const extended = new ExtendedReactionService(sourceDb, reactions, ids, mockDeep(), visibility, mockDeep(), emojis, mockDeep(), delivery);
	const reader = mockDeep<GridspacePrivateService>(); reader.readableSourceNote.mockResolvedValue(note); reader.peerNotes.mockResolvedValue({ notes: [{ id: note.id }] } as never);
	const links = mockDeep<GridspaceLinkService>(); links.authorizePrivate.mockResolvedValue({ localUserId: actor.id, initiator: false } as never);
	links.hasActionScope.mockResolvedValue(true); links.hasChannelScope.mockResolvedValue(true);
	const channelAuth = mockDeep<GridspaceChannelAuthService>(); channelAuth.source.mockResolvedValue(actor as MiRemoteUser);
	const placement = mockDeep<GridspacePlacementActionService>(); placement.source.mockResolvedValue({ user: actor as MiRemoteUser, note });
	const service = new GridspaceActionService(sourceDb, { ...config, url: 'https://source.test:8443' }, links, reader, reactions, mockDeep(), mockDeep(), mockDeep(), mockDeep(), extended, mockDeep(), channelAuth, placement);
	const credential = route === 'placement' ? { placementActorId: 'viewer', conversationUri: 'https://source.test:8443/notes/target' }
		: route === 'guest' ? { channelId: 'channel', channelActorId: 'viewer' } : { channelId: 'channel', linkId: 'link' };
	const act = (reaction: string, action: 'react' | 'add-reaction' = 'add-reaction') => service.peerAction({ ...credential, action, reaction, noteId: note.id }, async () => {});
	const stored = async (table = MiNoteReaction) => (await manager.getRepository(table).findOneBy({ userId: actor.id, noteId: note.id }))?.reaction;
	return { act, stored, note, emoji, utility, blocking, visibility, roles, actor, reactions };
}

const marker = ':cat@source.test:8443:';
const seed = (table: typeof MiNoteReaction, noteId = 'target', reaction = ':cat:') =>
	runner.manager.insert(table, { id: 'seed', userId: 'other', noteId, reaction });

test.each(['linked', 'guest', 'placement'] as const)('%s actions resolve the same existing source emoji for first and additional reactions', async route => {
	const f = fixture(route);
	await seed(MiExtendedNoteReaction, 'target', ':cat@.:');
	await f.act(marker, 'react');
	expect(await f.stored()).toBe(':cat:');
	await f.act(marker, 'react'); // desired state retry
	await runner.manager.delete(MiNoteReaction, { userId: f.actor.id });
	await f.act(marker);
	expect(await f.stored()).toBe(':cat:');
	await runner.manager.update(MiNoteReaction, { userId: f.actor.id }, { reaction: '👍' });
	await f.act(marker);
	expect(await f.stored(MiExtendedNoteReaction)).toBe(':cat:');
});

test.each([':cat:', ':cat@.:'])('guest picker %s retains its own namespace despite a source name collision', async input => {
	const f = fixture('guest');
	await seed(MiNoteReaction);
	await f.act(input);
	expect(await f.stored()).toBe(':cat@viewer.test:');
});

test.each(['other-note', 'foreign-row', 'wrong-host', 'native'] as const)('a source key is scoped to the note, stored namespace and authenticated peer path (%s)', async kind => {
	const f = fixture('guest');
	await seed(MiNoteReaction, kind === 'other-note' ? 'other' : 'target', kind === 'foreign-row' ? ':cat@viewer.test:' : ':cat:');
	if (kind === 'native') await f.reactions.createUnlocked(f.actor, f.note, marker);
	else await f.act(kind === 'wrong-host' ? ':cat@other.test:' : marker);
	expect(await f.stored()).toBe('❤');
});

test.each(['remote-like-only', 'local-only', 'role', 'sensitive', 'silenced', 'blocked', 'hidden'] as const)('the source emoji enforces %s for the real guest', async policy => {
	const f = fixture('placement');
	await seed(MiNoteReaction);
	if (policy === 'remote-like-only') f.note.reactionAcceptance = 'likeOnlyForRemote';
	if (policy === 'local-only') { f.emoji.localOnly = true; f.note.userHost = f.actor.host; }
	if (policy === 'role') f.emoji.roleIdsThatCanBeUsedThisEmojiAsReaction.push('required');
	if (policy === 'sensitive') { f.emoji.isSensitive = true; f.note.reactionAcceptance = 'nonSensitiveOnly'; }
	if (policy === 'silenced') f.utility.isMediaSilencedHost.mockImplementation((_hosts, host) => host === f.actor.host);
	if (policy === 'blocked') f.blocking.checkBlocked.mockResolvedValue(true);
	if (policy === 'hidden') f.visibility.isVisibleForMe.mockResolvedValue(false);
	if (policy === 'blocked' || policy === 'hidden') {
		await expect(f.act(marker)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
		expect(await f.stored()).toBeUndefined();
	} else {
		await f.act(marker);
		expect(await f.stored()).toBe('❤');
	}
	expect(f.blocking.checkBlocked).toHaveBeenCalledWith('author', 'viewer');
	if (policy === 'role') expect(f.roles.getUserRoles).toHaveBeenCalledWith('viewer');
});

test('a linked local actor retains permission to co-react with a source-local-only emoji', async () => {
	const f = fixture('linked');
	f.emoji.localOnly = true;
	await seed(MiNoteReaction);
	await f.act(marker);
	expect(await f.stored()).toBe(':cat:');
});
