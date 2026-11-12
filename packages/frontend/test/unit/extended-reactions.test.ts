/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { entities } from 'misskey-js';
import { fetchExtendedReactions, supportsExtendedReactions, watchSharedReactions } from '@/utility/extended-reactions.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/composables/use-note-capture.js', () => ({ noteEvents: { emit: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('paired extended reactions', () => {
	test('enables only local notes or marked public/home peer notes', () => {
		const note = { user: { host: null }, visibility: 'public' } as entities.Note;
		expect(supportsExtendedReactions(note)).toBe(true);
		expect(supportsExtendedReactions({ ...note, user: { host: 'other.example' } } as entities.Note)).toBe(false);
		const peer = { ...note, user: { host: 'peer.example' }, gridspaceShared: true } as entities.Note;
		expect(supportsExtendedReactions(peer)).toBe(true);
		expect(supportsExtendedReactions({ ...peer, visibility: 'home', localOnly: true })).toBe(true);
		expect(supportsExtendedReactions({ ...peer, visibility: 'followers' })).toBe(false);
		expect(supportsExtendedReactions({ ...peer, gridspaceShared: false, gridspaceReactions: true, visibility: 'followers' })).toBe(true);
		expect(supportsExtendedReactions({ ...peer, channel: { id: 'channel' } } as entities.Note)).toBe(false);
	});
	test('deduplicates mounted copies and batches no more than 100 notes', async () => {
		const api = vi.mocked(misskeyApi);
		api.mockImplementation((async (_endpoint: string, options: { noteIds: string[] }) => options.noteIds.map(noteId => ({ noteId }))) as never);
		const values = await Promise.all([...Array.from({ length: 101 }, (_, n) => fetchExtendedReactions(String(n))), fetchExtendedReactions('0')]);
		expect(api).toHaveBeenCalledTimes(2);
		expect(api.mock.calls[0][1]).toMatchObject({ noteIds: Array.from({ length: 100 }, (_, n) => String(n)) });
		expect(values[0]).toBe(values[101]);
	});
	test('shares one timer, pauses in hidden tabs and disposes the last subscription', async () => {
		vi.useFakeTimers();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		const first = vi.fn(); const second = vi.fn();
		const stopFirst = watchSharedReactions(first); const stopSecond = watchSharedReactions(second);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(10000);
		expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
		hidden.mockReturnValue(true); await vi.advanceTimersByTimeAsync(10000);
		expect(first).toHaveBeenCalledTimes(1);
		stopFirst(); hidden.mockReturnValue(false); await vi.advanceTimersByTimeAsync(10000);
		expect(second).toHaveBeenCalledTimes(2); expect(first).toHaveBeenCalledTimes(1);
		stopSecond(); expect(vi.getTimerCount()).toBe(0);
	});
});
