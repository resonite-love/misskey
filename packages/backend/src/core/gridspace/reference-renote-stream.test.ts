/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import type { Packed } from '@/misc/json-schema.js';
import { HomeTimelineChannel } from '@/server/api/stream/channels/home-timeline.js';
import { LocalTimelineChannel } from '@/server/api/stream/channels/local-timeline.js';

test.each([['home', HomeTimelineChannel], ['local', LocalTimelineChannel]] as const)('%s filters reference renotes at live delivery, including renote mutes', async (_name, ChannelType) => {
	const note = { id: 'note', userId: 'author', user: { id: 'author', host: null }, visibility: 'public', localOnly: true, gridspaceQuote: 'https://g.example/gridspace/private?noteId=n&channelId=c', text: null, cw: null, replyId: null, renoteId: null, fileIds: [], poll: null } as unknown as Packed<'Note'>;
	const muted = new Set<string>();
	const send = vi.fn();
	const channel = Object.assign(Object.create(ChannelType.prototype), {
		connection: { user: { id: 'viewer' }, following: { author: {} }, followingChannels: new Set(), userIdsWhoMeMuting: new Set(), userIdsWhoMeMutingRenotes: muted, userIdsWhoBlockingMe: new Set(), userMutedInstances: new Set(), mutingChannels: new Set() },
		gridspaceIdentity: { linkedUserId: async () => null },
		noteStreamingHidingService: { filter: async (value: unknown) => value },
		noteEntityService: { withMyRenoteReaction: async (value: unknown) => value },
		withRenotes: false, withFiles: false,
	}) as { onNote: (value: Packed<'Note'>) => Promise<void>; withRenotes: boolean };
	Object.defineProperty(channel, 'send', { value: send });
	await channel.onNote(note);
	expect(send).not.toHaveBeenCalled();
	channel.withRenotes = true;
	await channel.onNote(note);
	expect(send).toHaveBeenCalledOnce();
	send.mockClear(); muted.add('author');
	await channel.onNote(note);
	expect(send).not.toHaveBeenCalled();
	note.text = 'A comment';
	await channel.onNote(note);
	expect(send).toHaveBeenCalledOnce();
});
