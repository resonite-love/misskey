/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { SelectQueryBuilder } from 'typeorm';
import type { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { PrivatePeerRequest, PrivateWireNote } from './private-protocol.js';

test.each([true, false])('embeds one level from the related batch only while still readable (%s)', async stillReadable => {
	const parent = { id: 'wrapper', channelId: 'channel', text: null, renoteId: 'target' };
	const target = { id: 'target', channelId: 'channel', text: 'Original', renoteId: 'deeper' };
	const query = mockDeep<SelectQueryBuilder<MiNote>>(); query.andWhere.mockReturnValue(query);
	const read = vi.fn().mockResolvedValueOnce([target]).mockResolvedValueOnce([parent]).mockResolvedValueOnce(stillReadable ? [target] : []);
	const pack = vi.fn(async (note: MiNote) => ({ ...note, renoteId: note.id === 'wrapper' ? 'target' : null, filterActors: [] }));
	const reactions = vi.fn(async () => []);
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		authorizeRead: vi.fn(async () => ({ localUserId: 'viewer', initiator: false })), sourceNotes: vi.fn(async () => [parent]),
		query: () => query, search: { read }, pack, extendedReactions: { show: reactions }, ids: { parse: () => ({ date: new Date(0) }) },
	}) as GridspacePrivateService;
	const page = await service.peerNotes({ mode: 'channel', channelId: 'channel' } as PrivatePeerRequest);
	expect(pack).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(3);
	expect(reactions).toHaveBeenCalledWith(['wrapper', 'target'], { id: 'viewer' }, true);
	if (stillReadable) expect(page.notes[0].renote).toMatchObject({ id: 'target', text: 'Original', renoteId: null });
	else { expect(page.notes[0].renoteId).toBeNull(); expect(page.notes[0]).not.toHaveProperty('renote'); }
});

test.each([true, false])('destination filters the embedded target and strips internal actor lists (%s)', async readable => {
	const target = { id: 'target', text: 'Original', filterActors: [] } as unknown as PrivateWireNote;
	const parent = { id: 'wrapper', origin: 'https://r.example', renoteId: 'target', renote: target, filterActors: [] } as unknown as PrivateWireNote;
	const localAllows = vi.fn(async (_viewer, note) => note.id === 'wrapper' || readable);
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		peer: { origin: 'https://g.example', peerOrigin: 'https://r.example' },
		channelAuth: { destination: async () => ({ credential: { channelActorId: 'viewer' }, key: 'viewer', peerUserId: '', check: vi.fn() }) },
		links: { json: async () => ({ notes: [parent], observedAt: new Date().toISOString(), next: null }) }, localAllows,
	}) as GridspacePrivateService;
	const page = await service.notes({ id: 'viewer' } as MiLocalUser, { mode: 'channel', channelId: 'channel' }, 10);
	expect(localAllows).toHaveBeenCalledTimes(2);
	expect(page.notes[0]).not.toHaveProperty('filterActors');
	if (readable) { expect(page.notes[0].renote).toMatchObject({ text: 'Original' }); expect(page.notes[0].renote).not.toHaveProperty('filterActors'); } else expect(page.notes[0]).not.toHaveProperty('renote');
});
