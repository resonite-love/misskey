/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { renoteGridspaceChannel, selfRenoteGridspace } from '@/utility/gridspace-channel-renote.js';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
beforeEach(() => { api.mockReset(); window.sessionStorage.clear(); });
const prepared = { canReply: true, account: { uri: 'https://g.example/users/current' } };

test('self-renotes use the old-account endpoint and never choose a new author or audience', async () => {
	const actor = 'https://r.example/users/old';
	api.mockResolvedValueOnce({ ...prepared, account: { uri: actor } }).mockRejectedValueOnce(new Error('timeout'));
	await expect(selfRenoteGridspace('current', 'parent', actor)).rejects.toThrow('timeout');
	const sent = api.mock.calls[1][1];
	expect(sent).toMatchObject({ action: 'send', renoteId: 'parent', expectedActorUri: actor });
	expect(sent).not.toHaveProperty('channelId'); expect(sent).not.toHaveProperty('visibility');
	api.mockResolvedValueOnce({ ...prepared, account: { uri: actor } }).mockResolvedValueOnce({ createdNoteId: 'created' });
	await selfRenoteGridspace('current', 'parent', actor);
	expect(api.mock.calls[3][1].requestId).toBe(sent.requestId);
	expect(api.mock.calls.every(call => call[0] === 'gridspace/private-reply')).toBe(true);
});

test('does not send a self-renote if authorization resolves a different old account', async () => {
	api.mockResolvedValue(prepared);
	await expect(selfRenoteGridspace('current', 'parent', 'https://r.example/users/old')).rejects.toMatchObject({ uncertain: false });
	expect(api).toHaveBeenCalledTimes(1);
});

test('read-only grants prompt for posting permission without creating a renote', async () => {
	api.mockResolvedValue({ ...prepared, canReply: false });
	await expect(selfRenoteGridspace('current', 'parent', prepared.account.uri)).rejects.toMatchObject({ uncertain: false, permissionRequired: true });
	expect(api).toHaveBeenCalledTimes(1);
});

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
