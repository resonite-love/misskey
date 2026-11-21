/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import type { Packed } from '@/misc/json-schema.js';
import { HomeTimelineChannel } from '@/server/api/stream/channels/home-timeline.js';
import { LocalTimelineChannel } from '@/server/api/stream/channels/local-timeline.js';

test.each([
	['ordinary home', HomeTimelineChannel, false],
	['ordinary local', LocalTimelineChannel, false],
	['dedicated home', HomeTimelineChannel, true],
	['dedicated local', LocalTimelineChannel, true],
] as const)('%s filters reference renotes at live delivery, including renote mutes', async (_name, ChannelType, dedicated) => {
	const note = { id: 'note', userId: 'author', user: { id: 'author', host: null }, visibility: 'public', localOnly: true, gridspaceQuote: 'https://g.example/gridspace/private?noteId=n&channelId=c', text: null, cw: null, replyId: null, renoteId: null, fileIds: [], poll: null } as unknown as Packed<'Note'>;
	if (dedicated) Object.assign(note, { includeDefault: false, multiNoteKind: 'root', channelPlacements: [{ channelId: 'c', state: 'active' }],
		gridspaceQuote: 'https://g.example/notes/target?gridspaceChannelOrigin=https%3A%2F%2Fg.example&gridspaceChannelId=c' });
	const muted = new Set<string>();
	const watched = new Set<string>();
	const send = vi.fn();
	const channel = Object.assign(Object.create(ChannelType.prototype), {
		connection: { user: { id: 'viewer' }, following: { author: {} }, followingChannels: watched, userIdsWhoMeMuting: new Set(), userIdsWhoMeMutingRenotes: muted, userIdsWhoBlockingMe: new Set(), userMutedInstances: new Set(), mutingChannels: new Set() },
		placementNotes: { createQueryBuilder: () => ({ where() { return this; }, andWhere() { return this; }, getExists: async () => true }) },
		gridspaceIdentity: { linkedUserId: async () => null },
		noteStreamingHidingService: { filter: async (value: unknown) => value },
		noteEntityService: { withMyRenoteReaction: async (value: unknown) => value },
		withRenotes: false, withFiles: false,
	}) as { onNote: (value: Packed<'Note'>) => Promise<void>; withRenotes: boolean };
	Object.defineProperty(channel, 'send', { value: send });
	await channel.onNote(note);
	expect(send).not.toHaveBeenCalled();
	channel.withRenotes = true;
	if (dedicated) {
		await channel.onNote(note);
		expect(send).not.toHaveBeenCalled();
		watched.add('c');
		if (ChannelType === LocalTimelineChannel) {
			await channel.onNote(note);
			expect(send).not.toHaveBeenCalled();
			return;
		}
		channel.withRenotes = false;
		await channel.onNote(note);
		expect(send).not.toHaveBeenCalled();
		channel.withRenotes = true;
	}
	await channel.onNote(note);
	expect(send).toHaveBeenCalledOnce();
	send.mockClear(); muted.add('author');
	await channel.onNote(note);
	expect(send).not.toHaveBeenCalled();
	note.text = 'A comment';
	await channel.onNote(note);
	expect(send).toHaveBeenCalledOnce();
});
