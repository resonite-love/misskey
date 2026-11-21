/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it, vi } from 'vitest';
import { canUseDestinations, initialDestinations, placementParams, recoverNoteCreate, startNoteCreate, sameChannel } from '@/utility/multi-note.js';

const local = { origin: 'https://local.example', channelId: '1', name: 'Talk', color: '#000' };
const peer = { ...local, origin: 'https://peer.example' };

describe('note destinations', () => {
	it('starts on the regular timeline or the channel the composer was opened from', () => {
		expect(initialDestinations()).toEqual({ includeDefault: true, channels: [] });
		expect(initialDestinations(peer)).toEqual({ includeDefault: false, channels: [peer] });
	});

	it('distinguishes channels with the same name and ID on different servers', () => {
		expect(sameChannel(local, peer)).toBe(false);
		expect(placementParams({ includeDefault: true, channels: [peer, local] }, local.origin)).toEqual({
			includeDefault: true, channelIds: ['1'], channelTargets: [{ origin: peer.origin, channelId: '1' }],
		});
	});

	it('requires a destination and an explicit public visibility for channel publication', () => {
		expect(canUseDestinations({ includeDefault: false, channels: [] }, 'public')).toBe(false);
		expect(canUseDestinations(initialDestinations(), 'specified')).toBe(true);
		expect(canUseDestinations(initialDestinations(peer), 'followers')).toBe(false);
		expect(canUseDestinations(initialDestinations(peer), 'public')).toBe(true);
		const restricted = { ...local, allowRenoteToExternal: false };
		expect(canUseDestinations({ includeDefault: true, channels: [restricted] }, 'public')).toBe(false);
		expect(canUseDestinations(initialDestinations(restricted), 'public')).toBe(true);
		const sensitive = { ...peer, isSensitive: true };
		expect(canUseDestinations(initialDestinations(sensitive), 'public')).toBe(true);
		expect(canUseDestinations({ includeDefault: true, channels: [local, sensitive] }, 'public')).toBe(true);
		expect(canUseDestinations(initialDestinations(sensitive), 'home')).toBe(false);
		expect(canUseDestinations({ includeDefault: true, channels: [{ ...sensitive, allowRenoteToExternal: false }] }, 'public')).toBe(false);
	});
});

describe('create receipt recovery', () => {
	const pending = { accountId: 'author', clientRequestId: 'id', input: { text: 'first' }, inputHash: 'hash', draftSnapshot: 'first-draft' };

	it('stores the original wire values without mutable form objects or the session token', async () => {
		const input = { text: 'first', fileIds: ['one'], i: 'ephemeral' };
		const request = await startNoteCreate('author', input, 'first-draft');
		input.text = 'edited';
		input.fileIds.push('two');
		expect(request.input).toEqual({ text: 'first', fileIds: ['one'] });
		expect(JSON.parse(JSON.stringify(request)).clientRequestId).toBe(request.clientRequestId);
	});

	it('recovers a committed note when create lost its response without clearing a newer draft', async () => {
		const status = vi.fn().mockResolvedValue({ status: 'created', createdNote: { id: 'original' } });
		const result = await recoverNoteCreate(pending, status, async () => 'edited text or attachments');
		expect(status).toHaveBeenCalledWith(pending.clientRequestId);
		expect(result).toEqual({ status: 'created', createdNote: { id: 'original' }, clearDraft: false });
	});

	it('can finish an unchanged draft even when its confirmed note has already been deleted', async () => {
		const result = await recoverNoteCreate(pending, async () => ({ status: 'deleted', createdNote: null }), async () => 'first-draft');
		expect(result?.clearDraft).toBe(true);
	});

	it('keeps a missing or unreachable receipt pending for the next retry', async () => {
		const hash = vi.fn();
		expect(await recoverNoteCreate(pending, async () => ({ status: 'missing', createdNote: null }), hash)).toBeNull();
		await expect(recoverNoteCreate(pending, async () => { throw new Error('offline'); }, hash)).rejects.toThrow('offline');
		expect(hash).not.toHaveBeenCalled();
	});
});
