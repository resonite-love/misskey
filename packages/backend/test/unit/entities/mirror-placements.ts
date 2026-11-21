/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { MiNote } from '@/models/Note.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { PlacementMap } from '@/core/NotePlacementService.js';

test('packs prior shared mirrors from one viewer-specific placement lookup per page', async () => {
	const viewer = { id: 'viewer' };
	const user = { id: 'remoteAuthor' };
	const origin = 'https://origin.example';
	const mirror = (id: string) => new MiNote({
		id, uri: origin + '/notes/' + id, userHost: 'origin.example', userId: user.id,
		gridspaceShared: true, multiNoteKind: null, includeDefault: null, channelId: null,
		visibility: 'public', text: 'original', reactions: {}, emojis: [], tags: [], fileIds: [], mentions: [],
		reactionAndUserPairCache: [], visibleUserIds: [],
	});
	const root = mirror('root');
	const nested = mirror('nested');
	const deep = mirror('deep');
	const otherDeep = mirror('otherDeep');
	deep.replyId = 'not-rendered';
	nested.replyId = deep.id;
	const quote = new MiNote({ ...mirror('quote'), gridspaceShared: false, uri: null, renoteId: nested.id });
	const secondNested = new MiNote({ ...mirror('secondNested'), replyId: otherDeep.id, renoteId: 'secondQuote' });
	const secondQuote = new MiNote({ ...quote, id: 'secondQuote', renoteId: secondNested.id, renote: secondNested });
	const sharedNested = new MiNote({ ...mirror('sharedNested'), replyId: deep.id });
	const sharedQuote = new MiNote({ ...quote, id: 'sharedQuote', renoteId: sharedNested.id, renote: sharedNested });
	const hidden = mirror('hidden');
	hidden.visibility = 'specified';
	const chips = ['first', 'second'].map(channelId => ({
		origin, canonicalUri: origin + '/notes/root', channelId, name: channelId, color: '#fff', state: 'active' as const,
	}));
	const routes: PlacementMap = new Map([[root.id, chips]]);
	routes.rootNoteIds = new Set([root.id, nested.id, deep.id, otherDeep.id, 'filtered', hidden.id]);
	routes.unavailableNoteIds = new Set(['offline']);
	const lookup = vi.fn().mockResolvedValue(routes);
	const findRelated = vi.fn().mockResolvedValueOnce([nested]).mockResolvedValueOnce([deep, otherDeep]);

	const service = Object.create(NoteEntityService.prototype) as NoteEntityService;
	Object.assign(service, {
		meta: { enableReactionsBuffering: false },
		notesRepository: { find: findRelated },
		notePlacementService: { pack: lookup },
		idService: { gen: () => '0', parse: () => ({ date: new Date(1) }) },
		userEntityService: { packMany: async () => [user], pack: async () => user },
		driveFileEntityService: { packManyByIds: async () => [] },
		customEmojiService: { populateEmojis: async () => ({}), prefetchEmojis: async () => {} },
		reactionsBufferingService: { mergeReactions: () => ({}) },
		reactionService: { convertLegacyReactions: () => ({}) },
	});
	const mirrors = [root, mirror('ordinary'), mirror('filtered'), mirror('offline'), hidden];
	const [packed, ordinary, filtered, offline, invisible, quoted, second, shared] = await service.packMany([...mirrors, quote, secondQuote, sharedQuote], viewer);
	expect(findRelated.mock.calls.map(([query]) => query.where.id.value)).toEqual([[nested.id], [deep.id, otherDeep.id]]);
	expect(lookup.mock.calls).toEqual([[[...mirrors.map(note => note.id), secondNested.id, sharedNested.id, nested.id, deep.id, otherDeep.id], viewer]]);
	expect(packed).toMatchObject({ multiNoteKind: 'root', includeDefault: true, channelPlacements: chips });
	expect(ordinary.multiNoteKind).toBeUndefined();
	expect(ordinary.channelPlacements).toBeUndefined();
	expect(filtered).toMatchObject({ multiNoteKind: 'root', channelPlacements: [] });
	expect(offline.channelPlacementsUnavailable).toBe(true);
	expect(offline.multiNoteKind).toBeUndefined();
	expect(invisible.isHidden).toBe(true);
	expect(invisible.multiNoteKind).toBeUndefined();
	expect(invisible.channelPlacements).toBeUndefined();
	expect(quoted.renote).toMatchObject({ id: nested.id, multiNoteKind: 'root', reply: { id: deep.id, multiNoteKind: 'root' } });
	expect(quoted.renote?.reply?.reply).toBeUndefined();
	expect(second.renote).toMatchObject({ renote: null, reply: { id: otherDeep.id, multiNoteKind: 'root' } });
	expect(shared.renote?.reply).toMatchObject({ id: deep.id, multiNoteKind: 'root' });

	expect(await service.pack(root, viewer)).toMatchObject({ multiNoteKind: 'root', includeDefault: true, channelPlacements: chips });
	expect(lookup).toHaveBeenLastCalledWith([root.id], viewer);
	expect(root.multiNoteKind).toBeNull();
});
