/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { attachContentEmojis, type ContentEmojiCarrier } from './content-emojis.js';

function resolver() {
	const service = mockDeep<CustomEmojiService>();
	service.populateEmojis.mockResolvedValue({ foreign: 'https://other.example/foreign.png' });
	service.localEmojisCache.fetch.mockResolvedValue(new Map([
		['mentor', { publicUrl: 'https://r.example/mentor.webp' }],
		['blobzozo', { publicUrl: '/files/blob.webp' }],
	]) as never);
	return service;
}

describe('paired content emoji URLs', () => {
	test('exports source-local display-name emojis before the author becomes remote', async () => {
		const item: ContentEmojiCarrier = { user: { username: 'zozo', name: ':mentor::blobzozo:ぞぞかす:unknown:', emojis: {} } };
		await attachContentEmojis(item, resolver(), 'https://r.example');
		expect(item.user.emojis).toEqual({ mentor: 'https://r.example/mentor.webp', blobzozo: 'https://r.example/files/blob.webp' });
	});
	test('resolves nested Page body and Gallery description emojis without changing text', async () => {
		const item: ContentEmojiCarrier = { user: { username: 'owner' }, content: [{ type: 'section', children: [{ type: 'text', text: ':mentor:' }] }], description: ':blobzozo: :foreign:' };
		await attachContentEmojis(item, resolver(), 'https://r.example');
		expect(item.gridspaceEmojis).toEqual({ mentor: 'https://r.example/mentor.webp', blobzozo: 'https://r.example/files/blob.webp', foreign: 'https://other.example/foreign.png' });
		expect(item.description).toBe(':blobzozo: :foreign:');
	});
	test('ignores emoji-like text inside code blocks and keeps existing author URLs', async () => {
		const item: ContentEmojiCarrier = { user: { username: 'owner', emojis: { existing: 'https://r.example/kept.webp' } }, description: '```\n:mentor:\n```' };
		await attachContentEmojis(item, resolver(), 'https://r.example');
		expect(item.gridspaceEmojis).toEqual({});
		expect(item.user.emojis).toEqual({ existing: 'https://r.example/kept.webp' });
	});
});
