/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { PreferencesManager, type PossiblyNonNormalizedPreferencesProfile, type PreferencesProfile, type StorageProvider } from '@/preferences/manager.js';

vi.mock('@/os.js', () => ({}));

const plugin = { installId: 'sample', name: 'Sample', version: '1.0.0', active: true, config: {}, configData: {}, src: 'sample' };

function storage() {
	let saved: PossiblyNonNormalizedPreferencesProfile | null = null;
	const io: StorageProvider = {
		load: () => saved && structuredClone(saved),
		save: vi.fn(({ profile }) => { saved = JSON.parse(JSON.stringify(profile)); }),
		cloudGet: vi.fn(async () => null),
		cloudGetBulk: vi.fn(async () => ({})),
		cloudSet: vi.fn(async () => {}),
	};
	return { io, read: () => saved! as PreferencesProfile };
}

test('persists an installed plugin after reload', async () => {
	const { io } = storage();
	const manager = new PreferencesManager(io, { id: 'viewer' });
	await manager.cloudReady;
	manager.commit('plugins', [plugin]);
	const reloaded = new PreferencesManager(io, { id: 'viewer' });
	await reloaded.cloudReady;
	expect(reloaded.s.plugins).toEqual([plugin]);
});

test('receives the saved snapshot even when storage in another tab is stale', async () => {
	const { io, read } = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	await first.cloudReady;
	const stale = structuredClone(read());
	const secondIo = { ...io, load: () => structuredClone(stale), save: vi.fn((ctx: Parameters<StorageProvider['save']>[0]) => io.save(ctx)), cloudGetBulk: vi.fn<StorageProvider['cloudGetBulk']>(io.cloudGetBulk) };
	const second = new PreferencesManager({ ...secondIo, cloudGetBulk: secondIo.cloudGetBulk as StorageProvider['cloudGetBulk'] }, { id: 'viewer' });
	await second.cloudReady;
	secondIo.save.mockClear();
	secondIo.cloudGetBulk.mockClear();
	first.on('saved', profile => second.reloadProfile(profile));
	first.commit('plugins', [plugin]);
	expect(second.s.plugins).toEqual([plugin]);
	expect(read().preferences.plugins[0][1]).toEqual([plugin]);
	expect(secondIo.save).not.toHaveBeenCalled();
	expect(secondIo.cloudGetBulk).not.toHaveBeenCalled();
	// Applying the received snapshot must not retain mutable references to it.
	second.commit('plugins', []);
	expect(first.s.plugins).toEqual([plugin]);
});

test('does not write a stale profile back after a legacy reload', async () => {
	const { io, read } = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	await first.cloudReady;
	const stale = structuredClone(read());
	const second = new PreferencesManager({ ...io, load: () => stale }, { id: 'viewer' });
	await second.cloudReady;
	first.commit('plugins', [plugin]);
	second.reloadProfile();
	await Promise.resolve();
	expect(read().preferences.plugins[0][1]).toEqual([plugin]);
});

test('synchronizes disabling and removing a plugin without bringing it back', async () => {
	const { io } = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	const second = new PreferencesManager(io, { id: 'viewer' });
	await Promise.all([first.cloudReady, second.cloudReady]);
	first.on('saved', profile => second.reloadProfile(profile));
	second.on('saved', profile => first.reloadProfile(profile));
	first.commit('plugins', [plugin]);
	second.commit('plugins', [{ ...plugin, active: false }]);
	expect(first.s.plugins[0].active).toBe(false);
	first.commit('plugins', []);
	expect(second.s.plugins).toEqual([]);
	const reloaded = new PreferencesManager(io, { id: 'viewer' });
	await reloaded.cloudReady;
	expect(reloaded.s.plugins).toEqual([]);
});

test('preserves an installed plugin when a stale tab saves an unrelated setting before receiving it', async () => {
	const { io, read } = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	const second = new PreferencesManager(io, { id: 'viewer' });
	await Promise.all([first.cloudReady, second.cloudReady]);
	const messages: (() => void)[] = [];
	first.on('saved', profile => messages.push(() => second.reloadProfile(profile)));
	second.on('saved', profile => messages.push(() => first.reloadProfile(profile)));
	first.commit('plugins', [plugin]);
	second.commit('animation', !second.s.animation);
	for (let count = 0; messages.length && count < 10; count++) messages.shift()!();
	expect(messages).toHaveLength(0);
	expect(first.s.plugins).toEqual([plugin]);
	expect(second.s.plugins).toEqual([plugin]);
	expect(first.s.animation).toBe(second.s.animation);
	expect(read().preferences.plugins[0][1]).toEqual([plugin]);
});

test('reconciles simultaneous writes even if both tabs read stale storage', async () => {
	const { io, read } = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	await first.cloudReady;
	const stale = structuredClone(read());
	const second = new PreferencesManager({ ...io, load: () => structuredClone(stale) }, { id: 'viewer' });
	await second.cloudReady;
	const messages: (() => void)[] = [];
	first.on('saved', profile => messages.push(() => second.reloadProfile(profile)));
	second.on('saved', profile => messages.push(() => first.reloadProfile(profile)));
	first.commit('plugins', [plugin]);
	second.commit('animation', !second.s.animation);
	for (let count = 0; messages.length && count < 10; count++) messages.shift()!();
	expect(messages).toHaveLength(0);
	expect(first.s.plugins).toEqual([plugin]);
	expect(second.s.plugins).toEqual([plugin]);
	expect(first.s.animation).toBe(second.s.animation);
	expect(read().preferences.plugins[0][1]).toEqual([plugin]);
});

test('a later explicit removal wins over a newer stored version in a stale tab', async () => {
	const { io } = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	const second = new PreferencesManager(io, { id: 'viewer' });
	await Promise.all([first.cloudReady, second.cloudReady]);
	first.commit('plugins', [plugin]);
	second.reloadProfile(first.profile);
	first.commit('plugins', [{ ...plugin, active: false }]);
	first.commit('plugins', [{ ...plugin, name: 'Renamed' }]);
	second.commit('plugins', []);
	const reloaded = new PreferencesManager(io, { id: 'viewer' });
	await reloaded.cloudReady;
	expect(reloaded.s.plugins).toEqual([]);
});

test('keeps separate account settings when tabs edit the same preference', async () => {
	const { io } = storage();
	const first = new PreferencesManager(io, { id: 'first' });
	const second = new PreferencesManager(io, { id: 'second' });
	await Promise.all([first.cloudReady, second.cloudReady]);
	const messages: (() => void)[] = [];
	first.on('saved', profile => messages.push(() => second.reloadProfile(profile)));
	second.on('saved', profile => messages.push(() => first.reloadProfile(profile)));
	first.commit('autoTranslation.enabled', true);
	second.commit('autoTranslation.enabled', true);
	second.commit('autoTranslation.enabled', false);
	for (let count = 0; messages.length && count < 10; count++) messages.shift()!();
	expect(first.s['autoTranslation.enabled']).toBe(true);
	expect(second.s['autoTranslation.enabled']).toBe(false);
	const firstReloaded = new PreferencesManager(io, { id: 'first' });
	const secondReloaded = new PreferencesManager(io, { id: 'second' });
	await Promise.all([firstReloaded.cloudReady, secondReloaded.cloudReady]);
	expect(firstReloaded.s['autoTranslation.enabled']).toBe(true);
	expect(secondReloaded.s['autoTranslation.enabled']).toBe(false);
});

test('ignores a pending cloud response after another tab replaces the profile', async () => {
	const { io, read } = storage();
	const seed = new PreferencesManager(io, { id: 'viewer' });
	await seed.cloudReady;
	seed.getMatchedRecordOf('plugins')[2].sync = true;
	seed.save();
	let resolve!: (value: { plugins: typeof plugin[] }) => void;
	const pendingIo = { ...io, cloudGetBulk: vi.fn(() => new Promise<{ plugins: typeof plugin[] }>(done => { resolve = done; })) as StorageProvider['cloudGetBulk'] };
	const waiting = new PreferencesManager(pendingIo, { id: 'viewer' });
	seed.commit('plugins', [plugin]);
	waiting.reloadProfile(read());
	resolve({ plugins: [] });
	await waiting.cloudReady;
	expect(waiting.s.plugins).toEqual([plugin]);
	expect(read().preferences.plugins[0][1]).toEqual([plugin]);
});

test('does not overwrite a local change with an earlier cloud response', async () => {
	const { io, read } = storage();
	const seed = new PreferencesManager(io, { id: 'viewer' });
	await seed.cloudReady;
	seed.getMatchedRecordOf('plugins')[2].sync = true;
	seed.save();
	let resolve!: (value: { plugins: typeof plugin[] }) => void;
	const manager = new PreferencesManager({ ...io, cloudGetBulk: (() => new Promise<{ plugins: typeof plugin[] }>(done => { resolve = done; })) as StorageProvider['cloudGetBulk'] }, { id: 'viewer' });
	manager.commit('plugins', [plugin]);
	resolve({ plugins: [] });
	await manager.cloudReady;
	expect(manager.s.plugins).toEqual([plugin]);
	expect(read().preferences.plugins[0][1]).toEqual([plugin]);
});

test('still applies and saves a changed cloud value and notifies other tabs', async () => {
	const { io } = storage();
	const seed = new PreferencesManager(io, { id: 'viewer' });
	await seed.cloudReady;
	seed.getMatchedRecordOf('plugins')[2].sync = true;
	seed.save();
	const manager = new PreferencesManager({ ...io, cloudGetBulk: (async () => ({ plugins: [plugin] })) as StorageProvider['cloudGetBulk'] }, { id: 'viewer' });
	const saved = vi.fn();
	manager.on('saved', saved);
	await manager.cloudReady;
	expect(manager.s.plugins).toEqual([plugin]);
	expect(saved).toHaveBeenCalledOnce();
});
