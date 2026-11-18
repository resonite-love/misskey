/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import AdminEmojiSyncEndpoint from '@/server/api/endpoints/admin/gridspace/emojis.js';
import { decideEmoji, emojiContent, emojiDigest, sameEmoji, type SyncEmoji } from './emoji-sync-protocol.js';

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
