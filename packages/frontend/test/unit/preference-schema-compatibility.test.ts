/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { PreferencesManager, type PossiblyNonNormalizedPreferencesProfile, type StorageProvider } from '@/preferences/manager.js';

vi.mock('@/os.js', () => ({}));

function storage() {
	let snapshot: PossiblyNonNormalizedPreferencesProfile | null = null;
	const io: StorageProvider = {
		load: () => snapshot && structuredClone(snapshot),
		save: ({ profile }) => { snapshot = JSON.parse(JSON.stringify(profile)); },
		cloudGet: async () => null,
		cloudGetBulk: async () => ({}),
		cloudSet: async () => {},
	};
	return io;
}

test.each(['future.preference', 'constructor'])('retains unfamiliar preference %s and its revision across unrelated edits and reloads', async (setting) => {
	const io = storage();
	const manager = new PreferencesManager(io, { id: 'viewer' });
	await manager.cloudReady;
	const incoming = io.load()!;
	const scope = { account: 'viewer' };
	const revision = JSON.stringify([setting, { server: null, ...scope, device: null }]);
	incoming.preferences = { ...incoming.preferences, [setting]: [[scope, 'custom', {}]] };
	incoming.revisions = { ...incoming.revisions, [revision]: [1, 'future-client'] };
	const saved = vi.fn();
	manager.on('saved', saved);
	manager.reloadProfile(incoming);
	expect(saved).not.toHaveBeenCalled();
	manager.commit('animation', !manager.s.animation);
	const reloaded = new PreferencesManager(io, { id: 'viewer' });
	await reloaded.cloudReady;
	const profile: PossiblyNonNormalizedPreferencesProfile = reloaded.profile;
	expect(profile.preferences[setting]).toEqual(incoming.preferences[setting]);
	expect(profile.revisions?.[revision]).toEqual(incoming.revisions[revision]);
});

test('an unrelated preference revision preserves reactive array identity', async () => {
	const io = storage();
	const first = new PreferencesManager(io, { id: 'viewer' });
	await first.cloudReady;
	const second = new PreferencesManager(io, { id: 'viewer' });
	await second.cloudReady;
	const plugins = second.s.plugins;
	first.commit('animation', !first.s.animation);
	second.reloadProfile(first.profile);
	expect(second.s.animation).toBe(first.s.animation);
	expect(second.s.plugins).toBe(plugins);
});
