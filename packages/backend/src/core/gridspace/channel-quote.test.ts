/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mockDeep } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import { expect, test, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceQuoteService } from './GridspaceQuoteService.js';
import { parseChannelQuote, parsePlacementQuote } from './quote-reference.js';

const link = 'https://g.example/gridspace/private?noteId=note&channelId=channel';

function fixture() {
	const note = { id: 'note', channelId: 'channel', origin: 'https://r.example', uri: 'https://r.example/notes/note', visibility: 'public', canQuoteOutside: true, author: { host: 'g.example' } };
	const reader = { notes: vi.fn(async () => ({ notes: [note] })) };
	const service = new GridspaceQuoteService({ url: 'https://g.example', gridspace: { enabled: true, channelRole: 'client', peerUrl: 'https://r.example' } } as Config, reader as unknown as GridspacePrivateService, mockDeep<ModuleRef>());
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

const canonical = 'https://r.example/notes/root';
const owner = 'https://g.example';
const reference = canonical + '?gridspaceChannelOrigin=https%3A%2F%2Fg.example&gridspaceChannelId=channel';
const viewer = { id: 'viewer' } as MiLocalUser;

function placementFixture() {
	const source = { canonicalUri: canonical, origin: owner, channelId: 'channel', state: 'active', isArchived: false, allowRenoteToExternal: true };
	const note = { id: 'root', uri: canonical, origin: 'https://r.example', multiNoteKind: 'root', includeDefault: false, localOnly: true, visibility: 'public', channelPlacements: [source], files: [] };
	const reader = mockDeep<GridspacePrivateService>();
	reader.notes.mockResolvedValue({ notes: [note] } as never);
	const service = new GridspaceQuoteService({ url: owner, multiNote: { enabled: true }, gridspace: { enabled: true, peerUrl: 'https://r.example', channelRole: 'client' } } as Config, reader, mockDeep<ModuleRef>());
	return { service, source, note, reader };
}

test('a dedicated source uses the canonical signed conversation and the selected channel policy', async () => {
	const f = placementFixture();
	f.source.allowRenoteToExternal = false;
	expect((await f.service.prepare(viewer, reference, { origin: owner, channelId: 'channel' })).url).toBe(reference);
	expect(f.reader.notes).toHaveBeenCalledWith(viewer, { mode: 'show', noteId: 'root', conversationUri: canonical }, 1);
	await expect(f.service.prepare(viewer, reference)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
	await expect(f.service.prepare(viewer, reference, { origin: 'https://r.example', channelId: 'channel' })).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test.each([{ isArchived: true }, { allowRenoteToExternal: false }, { state: 'removed' }, { origin: 'https://r.example' }, { channelId: 'another' }, { canonicalUri: canonical + '2' }])('rechecks the exact placement at insertion (%j)', async change => {
	const f = placementFixture();
	const quote = await f.service.prepare(viewer, reference);
	Object.assign(f.source, change);
	await expect(quote.check()).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test('a blocked viewer or unpublished original cannot create a reference', async () => {
	const f = placementFixture();
	const quote = await f.service.prepare(viewer, reference);
	f.note.visibility = 'followers';
	await expect(quote.check()).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
	f.reader.notes.mockResolvedValue({ notes: [] } as never);
	await expect(f.service.prepare(viewer, reference)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test('an export disabled on the writing server is rejected under the insert transaction lock', async () => {
	const f = placementFixture();
	const quote = await f.service.prepare(viewer, reference);
	const manager = mockDeep<EntityManager>();
	manager.findOne.mockResolvedValue({ id: 'channel', isArchived: false, allowRenoteToExternal: false });
	await expect(quote.check(manager)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
	expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), { where: { id: 'channel' }, lock: { mode: 'for_no_key_update' } });
});

test.each([reference.replace('r.example', 'third.example'), reference.replace('2Fg.example', '2Fthird.example'), reference + '&gridspaceChannelId=another', reference + '&unknown=1', reference + '#fragment'])('rejects an invalid or unpaired placement reference before looking up a note', value => {
	expect(() => parsePlacementQuote(value, [owner, 'https://r.example'])).toThrow();
});

test('forbids renoting another textless placement reference', async () => {
	const f = placementFixture();
	Object.assign(f.note, { gridspaceQuote: reference });
	await expect(f.service.prepare(viewer, reference)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test('an existing reference can show its still-readable original after every source placement is removed', async () => {
	const f = placementFixture();
	f.note.channelPlacements = [];
	const target = parsePlacementQuote(reference, [owner, 'https://r.example'])!;
	expect((await f.service.resolvePlacement(viewer, target)).note?.id).toBe('root');
	await expect(f.service.prepare(viewer, reference)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
	f.reader.notes.mockResolvedValue({ notes: [] } as never);
	await expect(f.service.resolvePlacement(viewer, target)).rejects.toMatchObject({ code: 'ACTION_REJECTED' });
});

test('receipt parsing normalizes a reference without an allowlist and rejects non-origin route values', () => {
	expect(parsePlacementQuote(reference)?.url).toBe(reference);
	for (const invalid of ['https://other.example/notes/test', 'file://localhost', 'https://guest@other.example', 'https://other.example#']) {
		const url = new URL(reference);
		url.searchParams.set('gridspaceChannelOrigin', invalid);
		expect(() => parsePlacementQuote(url.href)).toThrow();
	}
});

test('opposite local source and destination moves lock their channels in stable order', async () => {
	const f = placementFixture();
	const quote = await f.service.prepare(viewer, reference, 'aaa');
	const manager = mockDeep<EntityManager>();
	manager.findOne.mockResolvedValue({ isArchived: false, allowRenoteToExternal: true });
	await quote.check(manager);
	expect(manager.findOne.mock.calls.slice(0, 2).map(([, options]) => options.where)).toEqual([{ id: 'aaa' }, { id: 'channel' }]);
});
