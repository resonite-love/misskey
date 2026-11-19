/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { GridspacePrivateService } from './GridspacePrivateService.js';

describe('delegated note author emoji', () => {
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
	});
});
