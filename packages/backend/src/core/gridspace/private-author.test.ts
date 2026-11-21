/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { MiNote } from '@/models/Note.js';

describe('delegated note author emoji', () => {
	test.each(['g.example', 'third.example', null])('normal notes resolve only missing paired emoji (%s)', async host => {
		const service = Object.assign(Object.create(NoteEntityService.prototype), {
			gridspacePeer: { origin: 'https://r.example', peerOrigin: 'https://g.example' },
			meta: { enableReactionsBuffering: false },
			idService: { parse: () => ({ date: new Date(0) }) },
			customEmojiService: { populateEmojis: async () => ({}) },
			userEntityService: { pack: async () => ({ id: 'author', host }) },
			driveFileEntityService: { packManyByIds: async () => [] },
			reactionService: { convertLegacyReactions: (reactions: object) => reactions },
			reactionsBufferingService: { mergeReactions: (reactions: object) => reactions },
		}) as NoteEntityService;
		const note = { id: 'note', userId: 'author', userHost: host, text: ':bloborange:', cw: null, visibility: 'public', emojis: ['bloborange'], reactions: {}, reactionAndUserPairCache: [], fileIds: [], tags: [], mentions: [], channelId: null, replyId: null, renoteId: null } as unknown as MiNote;
		const packed = await service.pack(note, undefined, { detail: false, skipHide: true });
		expect(packed.emojis).toEqual(host === 'g.example' ? { bloborange: 'https://g.example/emoji/bloborange.webp' } : host ? {} : undefined);
	});

	test('resolves uncached peer emoji without substituting the same local name', async () => {
		const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
			peer: { origin: 'https://r.example', peerOrigin: 'https://g.example' },
			emojis: { populateEmojis: vi.fn(async (names: string[]) => names.includes('known') ? { known: 'https://cached.example/known.png' } : {}), localEmojisCache: { fetch: async () => new Map([['bloborange', { publicUrl: 'https://r.example/different.png' }]]) } },
		});
		const urls = await service.emojiUrls(['bloborange', 'known', 'explicit@g.example', 'other@third.example', 'local@.', '../invalid'], 'g.example');
		expect(urls).toEqual({ bloborange: 'https://g.example/emoji/bloborange.webp', known: 'https://cached.example/known.png', 'explicit@g.example': 'https://g.example/emoji/explicit.webp' });
		expect(await service.emojiUrls(['bloborange'], 'third.example')).toEqual({});
		expect(await service.emojiUrls(['bloborange'], null)).toEqual({ bloborange: 'https://r.example/different.png' });
	});

	test.each([null, 'grid.example'])('uses the author emoji names and host (%s), independently of the body', async host => {
		const populateEmojis = vi.fn(async (names: string[], origin: string | null) => Object.fromEntries(names.map(name => [name, `https://${origin ?? 'source.example'}/${name}.png`])));
		const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
			peer: { origin: 'https://source.example' },
			emojis: { populateEmojis, localEmojisCache: { fetch: async () => new Map() } },
			db: { getRepository: () => ({ findBy: async () => [] }) },
			ids: { parse: () => ({ date: new Date(0) }) },
			users: { pack: async () => ({ id: 'source-only-id', avatarUrl: 'https://source.example/avatar.png', avatarBlurhash: null, avatarDecorations: [], isBot: true, isCat: false, instance: { name: 'Grid', themeColor: '#123456', faviconUrl: null, softwareVersion: 'private-extra' } }) },
			meta: { name: 'Source', iconUrl: null, themeColor: '#abcdef' },
		});
		const note = { id: 'note', text: 'body', cw: null, userId: 'author', userHost: host, user: { id: 'author', name: ':name:', username: 'author', host, emojis: ['name'], avatarId: null }, emojis: ['body'], fileIds: [], channelId: 'channel', channel: { id: 'channel', name: 'Channel', color: '#ff8a8a', userId: 'private-owner' } };
		const packed = await service.pack(note, 'reader', new Set(), { reactions: {}, myReaction: null, myReactions: [] });
		expect(packed.author.emojis).toEqual({ name: `https://${host ?? 'source.example'}/name.png` });
		expect(packed.emojis).toEqual({ body: `https://${host ?? 'source.example'}/body.png` });
		expect(populateEmojis).toHaveBeenCalledWith(['name'], host);
		expect(packed.author.isBot).toBe(true);
		expect(packed.author.instance.name).toBe(host ? 'Grid' : 'Source');
		expect(packed.author.id).toBeUndefined();
		expect(packed.author.instance.softwareVersion).toBeUndefined();
		expect(packed.channel).toEqual({ id: 'channel', name: 'Channel', color: '#ff8a8a' });
		for (const allowed of [true, false]) {
			const exportable = await service.pack({ ...note, visibility: 'public', channel: { ...note.channel, allowRenoteToExternal: allowed } }, 'reader', new Set(), { reactions: {}, myReaction: null, myReactions: [] });
			expect(exportable.canQuoteOutside).toBe(allowed);
		}
	});
});

test.each([false, true])('a mixed root retains confirmed placements when peer status is unknown (%s)', async unavailable => {
	const root = { id: 'root', multiNoteKind: 'root', includeDefault: true };
	const confirmed = [{ channelId: 'local', state: 'active' }];
	const placements = Object.assign(new Map([[root.id, confirmed]]), { unavailableNoteIds: new Set(unavailable ? [root.id] : []) });
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		placementActions: { source: async () => ({ user: { id: 'viewer' }, note: root }) },
		sourceNotes: async () => [root], query: () => ({ andWhere: vi.fn() }), search: { read: async () => [root] },
		ids: { parse: () => ({ date: new Date(0) }) },
		notePlacements: { pack: async () => placements }, extendedReactions: { show: async () => [] }, pack: async () => ({ ...root }),
	});
	const page = await service.peerNotes({ mode: 'show', placementActorId: 'viewer', conversationUri: 'https://source.example/notes/root', noteId: root.id });
	expect(page.notes).toHaveLength(1);
	expect(page.notes[0].channelPlacements).toEqual(confirmed);
	expect(page.notes[0].channelPlacementsUnavailable).toBe(unavailable ? true : undefined);
});
