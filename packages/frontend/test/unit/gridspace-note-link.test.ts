/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
import { isGridspaceNoteLink, isConfiguredGridspaceNoteLink } from '@/utility/gridspace-note-link.js';
test.each(['https://g.example/gridspace/private?noteId=abc&channelId=channel', 'https://r.example/gridspace/private?noteId=abc'])('recognizes a linked note URL: %s', value => expect(isGridspaceNoteLink(value)).toBe(true));
test.each(['https://g.example/notes/abc', 'https://g.example/gridspace/private?noteId=a&noteId=b', 'https://g.example/gridspace/private?noteId=a&token=b', 'http://g.example/gridspace/private?noteId=abc', 'https://user@g.example/gridspace/private?noteId=abc', 'https://g.example/gridspace/private?noteId=../abc'])('does not treat malformed URLs as quote targets: %s', value => expect(isGridspaceNoteLink(value)).toBe(false));

test('configuration failure stays unknown instead of exposing a private URL to public preview', async () => {
	api.mockRejectedValue(new Error('offline'));
	expect(await isConfiguredGridspaceNoteLink('https://g.example/gridspace/private?noteId=note')).toBeNull();
});
