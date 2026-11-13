/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { loadClipMenu } from '@/utility/clip-menu.js';

describe('clip picker', () => {
	test('combines native and linked clips without colliding IDs', async () => {
		const call = vi.fn(async path => path === 'clips/list' ? [{ id: 'same', name: 'local' }] : { items: [{ id: 'gridspace:clip:same', name: 'peer' }] });
		expect((await loadClipMenu(call)).clips.map(clip => clip.id)).toEqual(['same', 'gridspace:clip:same']);
	});
	test('refreshes on each open so new local and remote clips appear', async () => {
		const call = vi.fn(async path => path === 'clips/list' ? [] : { items: [] });
		await loadClipMenu(call); await loadClipMenu(call);
		expect(call).toHaveBeenCalledTimes(4);
	});
	test('keeps local clips available and reports a failed peer request', async () => {
		const call = vi.fn(async path => { if (path === 'clips/list') return [{ id: 'local' }]; throw new Error('offline'); });
		expect(await loadClipMenu(call)).toMatchObject({ clips: [{ id: 'local' }], peerUnavailable: true });
	});
});
