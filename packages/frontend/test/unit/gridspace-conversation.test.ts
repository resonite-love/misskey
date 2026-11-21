/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { conversationTarget, gridspaceDetailPath } from '@/utility/gridspace-conversation.js';

const reply = {
	id: 'response', uri: 'https://source.example/notes/response',
	multiNoteKind: 'conversation-reply', includeDefault: false,
};

describe('delegated conversation context', () => {
	test('targets the original note from either channel origin, even when channel IDs collide', () => {
		for (const channelId of ['sourceChannel', 'destinationChannel']) {
			expect(conversationTarget({ ...reply, channelId })).toEqual({ noteId: reply.id, conversationUri: reply.uri });
		}
	});

	test('links directly to a reply or its parent on the original server', () => {
		const current = new URL(gridspaceDetailPath(reply), 'https://viewer.example');
		expect(current.searchParams.get('conversationUri')).toBe(reply.uri);
		const parent = new URL(gridspaceDetailPath(reply, 'root'), current);
		expect([...parent.searchParams]).toEqual([['noteId', 'root'], ['conversationUri', 'https://source.example/notes/root']]);
	});

	test('keeps pre-placement channel links and requests compatible', () => {
		const legacy = { id: 'old', uri: 'https://peer.example/notes/old', channelId: 'legacy' };
		expect(conversationTarget(legacy)).toEqual({ noteId: 'old', channelId: 'legacy' });
		expect(gridspaceDetailPath(legacy)).toBe('/gridspace/private?noteId=old&channelId=legacy');
	});
});
