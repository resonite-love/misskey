/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { createAutoTranslationPreferenceSync } from '@/utility/auto-translation-preferences.js';

vi.mock('@/preferences.js', () => ({ prefer: {} }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: {} }));

function fixture(enabled = true, managed = true) {
	let pending: boolean | null = null;
	let listener: (value: boolean) => void = () => {};
	const apply = vi.fn();
	const save = vi.fn(async (value: boolean) => ({ managed: true, enabled: value }));
	const options = { load: vi.fn(async () => ({ managed, enabled })), save,
		getPending: () => pending, setPending: (value: boolean | null) => { pending = value; },
		apply, listen: (cb: typeof listener) => { listener = cb; } };
	return { sync: createAutoTranslationPreferenceSync(options), options, apply, save, setPending: options.setPending, change: (value: boolean) => listener(value), pending: () => pending };
}

test('applies initial ON and reads saved OFF on another device without rewriting it', async () => {
	const first = fixture(); await first.sync.start(); expect(first.apply).toHaveBeenCalledWith(true);
	const second = fixture(false); await second.sync.start(); expect(second.apply).toHaveBeenCalledWith(false);
	expect(second.save).not.toHaveBeenCalled();
});
test('persists user OFF and retains it through a failed save and reload', async () => {
	const first = fixture(); await first.sync.start(); first.save.mockRejectedValueOnce(new Error('offline'));
	first.change(false); await vi.waitFor(() => expect(first.save).toHaveBeenCalledWith(false));
	expect(first.pending()).toBe(false);
	const second = fixture(); second.setPending(first.pending()); await second.sync.start();
	expect(second.apply).toHaveBeenCalledWith(false); expect(second.save).toHaveBeenCalledWith(false); expect(second.pending()).toBeNull();
});
test('serializes toggles so a slow old write cannot overwrite the newest choice', async () => {
	const f = fixture(); await f.sync.start();
	let release!: () => void;
	f.save.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ managed: true, enabled: false }); }));
	f.change(false); f.change(true); release();
	await vi.waitFor(() => expect(f.save.mock.calls).toEqual([[false], [true]]));
	expect(f.pending()).toBeNull();
});
test('retries a pending user choice when connectivity returns', async () => {
	const f = fixture(); await f.sync.start(); f.save.mockRejectedValueOnce(new Error('offline')); f.change(false);
	await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce()); await f.sync.flush();
	expect(f.save).toHaveBeenCalledTimes(2); expect(f.pending()).toBeNull();
});
test('does not change source server preferences', async () => {
	const f = fixture(false, false); await f.sync.start(); f.change(true);
	expect(f.apply).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
});

test('captures OFF even if the initial load and its immediate retry fail', async () => {
	const f = fixture(); f.options.load.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline'));
	await expect(f.sync.start()).rejects.toThrow('offline');
	f.change(false);
	await vi.waitFor(() => expect(f.options.load).toHaveBeenCalledTimes(2));
	await f.sync.flush().catch(() => {});
	expect(f.pending()).toBe(false);
	await f.sync.flush();
	expect(f.apply).toHaveBeenCalledWith(false); expect(f.save).toHaveBeenCalledWith(false);
	expect(f.pending()).toBeNull();
});
