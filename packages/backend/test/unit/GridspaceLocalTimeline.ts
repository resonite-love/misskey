/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Packed } from '@/misc/json-schema.js';
import type { RoleService } from '@/core/RoleService.js';
import type { MetaService } from '@/core/MetaService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { ChannelRequest } from '@/server/api/stream/channel.js';
import type { NoteStreamingHidingService } from '@/server/api/stream/NoteStreamingHidingService.js';
import { LocalTimelineChannel } from '@/server/api/stream/channels/local-timeline.js';

const note = (fields: Partial<Packed<'Note'>> = {}) => ({ id: 'n', userId: 'author', user: { id: 'author', host: 'peer.example', requireSigninToViewContents: false }, visibility: 'public', localOnly: true, gridspaceShared: true, gridspaceReactions: true, text: 'shared note', cw: null, fileIds: [], files: [], reply: null, renote: null, channelId: null, ...fields }) as Packed<'Note'>;
async function fixture(options: { visitor?: boolean; allowed?: boolean; muted?: boolean; hidden?: boolean; withFiles?: boolean } = {}) {
	const subscriber = new EventEmitter(); const sendMessageToWs = vi.fn();
	const roles = mockDeep<RoleService>(); roles.getUserPolicies.mockResolvedValue({ ltlAvailable: options.allowed !== false } as never);
	const filter = mockDeep<NoteStreamingHidingService>(); filter.filter.mockImplementation(async n => options.hidden ? null : n);
	const packer = mockDeep<NoteEntityService>(); packer.withMyRenoteReaction.mockImplementation(async n => n);
	const request = { id: 'ltl', connection: { user: options.visitor ? null : { id: 'unlinked-viewer' }, subscriber, sendMessageToWs,
		following: {}, followingChannels: new Set(), userIdsWhoMeMuting: new Set(options.muted ? ['author'] : []), userIdsWhoMeMutingRenotes: new Set(), userIdsWhoBlockingMe: new Set(), userMutedInstances: new Set(), mutingChannels: new Set() } } as unknown as ChannelRequest;
	const channel = new LocalTimelineChannel(request, mockDeep<MetaService>(), roles, packer, filter);
	await channel.init({ withFiles: options.withFiles ?? false });
	return { channel, sendMessageToWs, async emit(n: Packed<'Note'>) { subscriber.emit('notesStream', n); for (let i = 0; i < 15; i++) await Promise.resolve(); } };
}
describe('LTL extension regression baseline', () => {
	test('an unlinked viewer receives a shared peer local-only public note and its reaction flag', async () => {
		const f = await fixture(); await f.emit(note());
		expect(f.sendMessageToWs).toHaveBeenCalledTimes(1);
		expect(f.sendMessageToWs.mock.calls[0][1]).toMatchObject({ type: 'note', body: { localOnly: true, gridspaceShared: true, gridspaceReactions: true } });
		f.channel.dispose();
	});
	test('a normal local public note still arrives', async () => {
		const f = await fixture(); await f.emit(note({ gridspaceShared: false, user: { id: 'author', host: null } as never }));
		expect(f.sendMessageToWs).toHaveBeenCalledTimes(1); f.channel.dispose();
	});
	test.each([
		['unrelated remote', { gridspaceShared: false }],
		['followers only', { visibility: 'followers' }],
		['specified recipients', { visibility: 'specified' }],
		['channel post', { channelId: 'channel' }],
	] as const)('does not add a %s post to the LTL', async (_name, fields) => {
		const f = await fixture(); await f.emit(note(fields)); expect(f.sendMessageToWs).not.toHaveBeenCalled(); f.channel.dispose();
	});
	test.each([{ muted: true }, { hidden: true }, { allowed: false }, { withFiles: true }])('keeps existing filtering %j', async options => {
		const f = await fixture(options); await f.emit(note()); expect(f.sendMessageToWs).not.toHaveBeenCalled(); f.channel.dispose();
	});
	test('does not show sign-in-only authors to visitors', async () => {
		const f = await fixture({ visitor: true }); await f.emit(note({ user: { id: 'author', host: 'peer.example', requireSigninToViewContents: true } as never }));
		expect(f.sendMessageToWs).not.toHaveBeenCalled(); f.channel.dispose();
	});
});
