/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Packed } from '@/misc/json-schema.js';
import type { PackedChannelPlacement } from '@/core/NotePlacementService.js';
import { NoteStreamingHidingService } from './NoteStreamingHidingService.js';

function fixture() {
	type Args = ConstructorParameters<typeof NoteStreamingHidingService>;
	const notes = mockDeep<Args[1]>();
	const placements = mockDeep<Args[2]>();
	notes.shouldHideNote.mockResolvedValue(false);
	return { service: new NoteStreamingHidingService({ ugcVisibilityForVisitor: 'all' } as Args[0], notes, placements), notes, placements };
}

function chip(name: string): PackedChannelPlacement {
	return { origin: 'https://site.example', channelId: name, canonicalUri: 'https://site.example/notes/n', name, color: '#123456', state: 'active' };
}

function note(id: string, fields: Partial<Packed<'Note'>> = {}): Packed<'Note'> {
	return { id, user: { host: null }, text: 'public body', ...fields } as Packed<'Note'>;
}

test('repacks every nested placement once per viewer and preserves the shared broadcast', async () => {
	const { service, placements } = fixture();
	const published = [chip('open'), chip('blocked')];
	const root = note('root', { multiNoteKind: 'root', channelPlacements: published });
	const shared = note('quote', { renote: root, reply: note('parent', { reply: root }) });
	placements.pack.mockResolvedValue(new Map([['root', [chip('open')]]]));
	const result = await service.filter(shared, 'viewer');
	expect(placements.pack).toHaveBeenCalledExactlyOnceWith(['root'], { id: 'viewer' });
	expect(result?.renote?.text).toBe('public body');
	expect(result?.renote?.channelPlacements).toEqual([chip('open')]);
	expect(result?.reply?.reply?.channelPlacements).toEqual([chip('open')]);
	expect(shared.renote?.channelPlacements).toBe(published);
});

test('drops hidden placement fields and resolves current anonymous placement state', async () => {
	const { service, notes, placements } = fixture();
	notes.shouldHideNote.mockImplementation(async n => n.id === 'hidden');
	notes.hideNote.mockImplementation(n => { n.isHidden = true; });
	placements.pack.mockResolvedValue(new Map());
	const stale = { multiNoteKind: 'root' as const, channelPlacements: [chip('removed')], channelPlacementsUnavailable: true };
	const result = await service.filter(note('root', { ...stale, reply: note('hidden', stale) }), null);
	expect(placements.pack).toHaveBeenCalledExactlyOnceWith(['root'], null);
	expect(result?.channelPlacements).toEqual([]);
	expect(result?.channelPlacementsUnavailable).toBeUndefined();
	expect(result?.reply?.channelPlacements).toBeUndefined();
	expect(result?.reply?.channelPlacementsUnavailable).toBeUndefined();
});

test('preserves the fast path for ordinary notes with no placements', async () => {
	const { service, placements } = fixture();
	const ordinary = note('ordinary');
	expect(await service.filter(ordinary, 'viewer')).toBe(ordinary);
	expect(placements.pack).not.toHaveBeenCalled();
});

test('a signed-in reader gets the verified mirror root and permitted chips on both nested branches', async () => {
	const { service, placements } = fixture();
	const mirror = note('mirror', { gridspaceShared: true, uri: 'https://peer.example/notes/source' });
	const broadcast = note('quote', { renote: mirror, reply: note('parent', { reply: mirror }) });
	const allowed = [chip('first'), chip('second')];
	placements.pack.mockResolvedValue(Object.assign(new Map([['mirror', allowed]]), { rootNoteIds: new Set(['mirror']) }));
	const result = await service.filter(broadcast, 'viewer');
	expect(placements.pack).toHaveBeenCalledExactlyOnceWith(['mirror'], { id: 'viewer' });
	for (const nested of [result?.renote, result?.reply?.reply]) {
		expect(nested).toMatchObject({ multiNoteKind: 'root', channelPlacements: allowed, text: 'public body' });
	}
	expect(mirror.multiNoteKind).toBeUndefined();
});

test('discards stale mirror root markers for unverified and hidden notes and preserves the native root', async () => {
	const { service, notes, placements } = fixture();
	const published = { multiNoteKind: 'root' as const, channelPlacements: [chip('blocked'), chip('muted')] };
	const mirror = { ...published, gridspaceShared: true, uri: 'https://peer.example/notes/source' };
	const broadcast = note('original', { ...published, gridspaceShared: true, reply: note('hidden', mirror), renote: note('mirror', mirror) });
	notes.shouldHideNote.mockImplementation(async n => n.id === 'hidden');
	notes.hideNote.mockImplementation(n => { n.isHidden = true; });
	placements.pack.mockResolvedValue(Object.assign(new Map(), { unavailableNoteIds: new Set(['mirror']) }));
	const result = await service.filter(broadcast, 'viewer');
	expect(placements.pack).toHaveBeenCalledExactlyOnceWith(['original', 'mirror'], { id: 'viewer' });
	expect(result).toMatchObject({ multiNoteKind: 'root', channelPlacements: [] });
	expect(result?.renote).toMatchObject({ text: 'public body', channelPlacementsUnavailable: true });
	for (const nested of [result?.renote, result?.reply]) {
		expect(nested?.multiNoteKind).toBeUndefined();
		expect(nested?.channelPlacements).toBeUndefined();
	}
	expect(result?.reply?.isHidden).toBe(true);
	expect(broadcast.renote?.multiNoteKind).toBe('root');
});
