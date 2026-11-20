/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceQuoteService } from './GridspaceQuoteService.js';
import { parseChannelQuote } from './quote-reference.js';

const link = 'https://g.example/gridspace/private?noteId=note&channelId=channel';

function fixture() {
	const note = { id: 'note', channelId: 'channel', origin: 'https://r.example', uri: 'https://r.example/notes/note', visibility: 'public', canQuoteOutside: true, author: { host: 'g.example' } };
	const reader = { notes: vi.fn(async () => ({ notes: [note] })) };
	const service = new GridspaceQuoteService({ url: 'https://g.example', gridspace: { enabled: true, channelRole: 'client', peerUrl: 'https://r.example' } } as Config, reader as unknown as GridspacePrivateService);
	return { note, reader, prepare: () => service.prepare({ id: 'viewer' } as MiLocalUser, link) };
}

test('keeps the R storage reference even when its author is on G, and rechecks before saving', async () => {
	const f = fixture();
	const quote = await f.prepare();
	expect(quote.url).toBe(link);
	await quote.check();
	expect(f.reader.notes).toHaveBeenCalledTimes(2);
	expect(f.reader.notes).toHaveBeenLastCalledWith({ id: 'viewer' }, { mode: 'show', noteId: 'note', channelId: 'channel' }, 1);
});

test.each([{ canQuoteOutside: false }, { channelId: 'wrong' }, { origin: 'https://third.example' }, { visibility: 'followers' }, { visibility: 'specified' }])('rejects a channel quote without current permission: %j', async patch => {
	const f = fixture(); Object.assign(f.note, patch);
	await expect(f.prepare()).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test('a revoked or deleted source cannot pass the second check', async () => {
	const f = fixture(); const quote = await f.prepare();
	f.reader.notes.mockResolvedValue({ notes: [] });
	await expect(quote.check()).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test.each(['https://other.example/gridspace/private?noteId=n&channelId=c', 'https://g.example/gridspace/private?noteId=n&channelId=c&extra=1', 'https://g.example/gridspace/private?noteId=n', 'http://g.example/gridspace/private?noteId=n&channelId=c', 'https://g.example/gridspace/private?noteId=n&channelId=c#x'])('rejects noncanonical source references: %s', value => {
	expect(() => parseChannelQuote(value, 'https://g.example')).toThrow();
});
