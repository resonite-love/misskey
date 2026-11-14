/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { renoteGridspaceChannel } from '@/utility/gridspace-channel-renote.js';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
beforeEach(() => { api.mockReset(); window.sessionStorage.clear(); });
const prepared = { canReply: true, account: { uri: 'https://g.example/users/current' } };

test('uses the channel endpoint and retries the same request after an uncertain response', async () => {
	api.mockResolvedValueOnce(prepared).mockRejectedValueOnce(new Error('timeout'));
	await expect(renoteGridspaceChannel('current', 'channel', 'parent')).rejects.toThrow('timeout');
	const sent = api.mock.calls[1][1];
	expect(sent).toMatchObject({ action: 'send', channelId: 'channel', renoteId: 'parent', expectedActorUri: prepared.account.uri });
	expect(sent).not.toHaveProperty('noteId');
	api.mockResolvedValueOnce(prepared).mockResolvedValueOnce({ createdNoteId: 'created' });
	await renoteGridspaceChannel('current', 'channel', 'parent');
	expect(api.mock.calls[3][1].requestId).toBe(sent.requestId);
	api.mockResolvedValueOnce(prepared).mockResolvedValueOnce({ createdNoteId: 'second' });
	await renoteGridspaceChannel('current', 'channel', 'parent');
	expect(api.mock.calls[5][1].requestId).not.toBe(sent.requestId);
	expect(api.mock.calls.every(call => call[0] === 'gridspace/channel-post')).toBe(true);
});

test('does not send when the source channel cannot be written', async () => {
	api.mockResolvedValueOnce({ ...prepared, canReply: false });
	await expect(renoteGridspaceChannel('current', 'channel', 'parent')).rejects.toThrow();
	expect(api).toHaveBeenCalledTimes(1);
});
