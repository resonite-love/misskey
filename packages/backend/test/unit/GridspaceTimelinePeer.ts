/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi, afterEach } from 'vitest';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import type { PrivatePeerRequest, PrivateWireNote } from '@/core/gridspace/private-protocol.js';

const origin = 'https://peer.example';
const input = { channelActorId: 'viewer', mode: 'validate', contextMode: 'home', timelineValidate: true, ids: ['note'] } as PrivatePeerRequest;

function fixture(now: number, policy: { hidden?: number; followers?: number } = {}) {
	const query = { andWhere: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis() };
	const note = { id: 'note', uri: `${origin}/notes/note`, userId: 'author', user: { makeNotesHiddenBefore: policy.hidden, makeNotesFollowersOnlyBefore: policy.followers } };
	const packed = { id: 'note', uri: note.uri, origin } as PrivateWireNote;
	const authorizeRead = vi.fn().mockResolvedValue({ localUserId: 'viewer', initiator: false });
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		peer: { origin, peerOrigin: 'https://destination.example' },
		authorizeRead,
		timelineReferences: { status: vi.fn().mockResolvedValue({ generation: 1 }), currentPosition: vi.fn().mockResolvedValue('0') },
		peerNotes: vi.fn().mockResolvedValue({ notes: [packed], next: null, head: null, scannedThrough: null, observedAt: new Date(now).toISOString() }),
		query: vi.fn().mockReturnValue(query),
		search: { read: vi.fn().mockResolvedValue([note]) },
		ids: { parse: vi.fn().mockReturnValue({ date: new Date(now - 8000) }) },
	}) as GridspacePrivateService;
	return { service, authorizeRead, note, packed };
}

afterEach(() => vi.restoreAllMocks());

describe('private timeline final authorization and leases', () => {
	test('revocation after body packing rejects the complete response', async () => {
		const f = fixture(Date.now());
		f.authorizeRead.mockResolvedValueOnce({ localUserId: 'viewer', initiator: false }).mockRejectedValueOnce(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
		await expect(f.service.peerTimeline(input)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});

	test('a relative author deadline shortens the one-minute lease', async () => {
		const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
		const f = fixture(now, { hidden: -10 });
		const page = await f.service.peerTimeline(input);
		expect(page).toMatchObject({ validForMs: 2000 });
	});

	test('crossing a hidden deadline after the policy query leaves no usable lease', async () => {
		const now = Date.now(); let clock = now;
		vi.spyOn(Date, 'now').mockImplementation(() => { clock += 1000; return clock; });
		const f = fixture(now, { hidden: -9 });
		const page = await f.service.peerTimeline(input);
		expect(page).toMatchObject({ validForMs: 0 });
	});

	test('already-authorized follower policies do not permanently expire the row', async () => {
		const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
		const f = fixture(now, { followers: -1 });
		const page = await f.service.peerTimeline(input);
		expect(page).toMatchObject({ validForMs: 60_000 });
	});
});
