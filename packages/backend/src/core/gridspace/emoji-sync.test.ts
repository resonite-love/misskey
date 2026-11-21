/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import AdminEmojiSyncEndpoint from '@/server/api/endpoints/admin/gridspace/emojis.js';
import { decideEmoji, emojiContent, emojiDigest, emojiReactionPair, sameEmoji, type SyncEmoji } from './emoji-sync-protocol.js';
import { GridspaceEmojiSyncService } from './GridspaceEmojiSyncService.js';
import EmojiAliasesEndpoint from '@/server/api/endpoints/gridspace/emoji-aliases.js';

function emoji(changes: Partial<SyncEmoji> = {}): SyncEmoji {
	const item = { id: 'emojiA', name: 'cat', originalUrl: 'https://a.test/cat.png', imageHash: 'a'.repeat(32), category: null, aliases: ['cat', 'ねこ'], license: null, isSensitive: false, localOnly: false, restricted: false, ...changes };
	return { ...item, hash: emojiDigest({ id: item.id, ...emojiContent(item), originalUrl: item.originalUrl }) };
}

const a = emoji(), b = emoji({ id: 'emojiB', originalUrl: 'https://b.test/copied.png' });

test('the admin endpoint initializes with Misskey JSON validation and rejects malformed IDs', async () => {
	const admin = vi.fn(async () => ({}));
	const endpoint = new AdminEmojiSyncEndpoint({ admin } as never);
	await endpoint.exec({ action: 'status' }, {} as never, null);
	expect(admin).toHaveBeenCalledOnce();
	await expect(endpoint.exec({ action: 'ignore', id: 'invalid', expectedA: null, expectedB: null }, {} as never, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
});

test('the same image and metadata may have different local IDs and storage URLs', () => {
	expect(a.hash).not.toBe(b.hash);
	expect(sameEmoji(a, b)).toBe(true);
	expect(decideEmoji(a, b, null, null)).toBe('same');
});
test('a one-sided addition is copied in either direction', () => {
	expect(decideEmoji(a, undefined, null, null)).toBe('toB');
	expect(decideEmoji(undefined, b, null, null)).toBe('toA');
});
test('same-name different image on initial discovery requires confirmation', () => {
	expect(decideEmoji(a, emoji({ imageHash: 'b'.repeat(32) }), null, null)).toBe('conflict');
});
test('one changed side propagates a rename and metadata without a reverse echo', () => {
	const changed = emoji({ name: 'new_cat', isSensitive: true });
	expect(decideEmoji(changed, b, a.hash, b.hash)).toBe('toB');
	const copied = emoji({ id: b.id, originalUrl: b.originalUrl, name: 'new_cat', isSensitive: true });
	expect(decideEmoji(changed, copied, changed.hash, copied.hash)).toBe('same');
});
test('simultaneous changes, deletions, and role restrictions cannot silently overwrite', () => {
	expect(decideEmoji(emoji({ name: 'one' }), emoji({ name: 'two' }), a.hash, b.hash)).toBe('conflict');
	expect(decideEmoji(undefined, b, a.hash, b.hash)).toBe('removed');
	expect(decideEmoji(a, undefined, a.hash, b.hash)).toBe('removed');
	expect(decideEmoji(emoji({ restricted: true }), undefined, null, null)).toBe('restricted');
});
test('alias order is immaterial, but local-only, category and license are synchronized', () => {
	expect(sameEmoji(a, emoji({ aliases: [...a.aliases].reverse() }))).toBe(true);
	for (const changes of [{ localOnly: true }, { category: 'cats' }, { license: 'CC0' }]) {
		expect(decideEmoji(a, emoji(changes), a.hash, b.hash)).toBe('toA');
	}
});

test('reaction grouping requires a synchronized pair whose current images and metadata still match', () => {
	const row = { state: 'synced', aId: a.id, bId: b.id, hashA: a.hash, hashB: b.hash };
	expect(emojiReactionPair(row, a, b)).toMatchObject({ name: 'cat', aId: a.id, bId: b.id });
	for (const state of ['pending', 'conflict', 'failed', 'ignored']) expect(emojiReactionPair({ ...row, state }, a, b)).toBeNull();
	expect(emojiReactionPair(row, a, undefined)).toBeNull();
	expect(emojiReactionPair(row, a, emoji({ ...b, imageHash: 'f'.repeat(32) }))).toBeNull();
	expect(emojiReactionPair(row, emoji({ restricted: true }), b)).toBeNull();
	expect(emojiReactionPair({ ...row, hashA: 'stale' }, a, b)).toBeNull();
});

test('the follower verifies its local emoji and shares a bounded cache across callers', async () => {
	const local = emoji({ id: 'local' });
	const json = vi.fn(async () => ({ originA: 'https://a.test', originB: 'https://b.test', pairs: [{ name: 'cat', aId: a.id, bId: local.id, aHash: a.hash, bHash: local.hash }] }));
	const service = new GridspaceEmojiSyncService({ url: 'https://b.test', gridspace: { enabled: true, peerUrl: 'https://a.test' } } as never, {} as never, { json } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
	vi.spyOn(service, 'manifest').mockResolvedValue({ origin: 'https://b.test', revision: '', emojis: [local] });
	const endpoint = new EmojiAliasesEndpoint(service);
	expect(await endpoint.exec({}, null, null)).toEqual({ aliases: { ':cat@a.test:': ':cat@.:' } });
	expect(await service.reactionAliases()).toEqual({ ':cat@a.test:': ':cat@.:' });
	expect(json).toHaveBeenCalledTimes(1);
	const now = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
	vi.spyOn(service, 'manifest').mockResolvedValue({ origin: 'https://b.test', revision: '', emojis: [emoji({ ...local, name: 'renamed' })] });
	expect(await service.reactionAliases()).toEqual({});
	vi.restoreAllMocks();
});

test('disabled synchronization and unreachable peers keep ordinary reactions usable', async () => {
	const json = vi.fn(async () => { throw new Error('offline'); });
	const make = (enabled: boolean) => new GridspaceEmojiSyncService({ url: 'https://b.test', gridspace: { enabled, peerUrl: 'https://a.test' } } as never, {} as never, { json } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
	expect(await make(false).reactionAliases()).toEqual({});
	const service = make(true);
	vi.spyOn(service, 'manifest').mockResolvedValue({ origin: 'https://b.test', revision: '', emojis: [a] });
	expect(await service.reactionAliases()).toEqual({});
	for (let n = 0; n < 10; n++) expect(await service.reactionAliases()).toEqual({});
	expect(json).toHaveBeenCalledTimes(1);
});
