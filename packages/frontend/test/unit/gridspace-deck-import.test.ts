/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import type { DeckProfile } from '@/deck.js';
const { state } = vi.hoisted(() => ({ state: { 'deck.profile': null as string | null, 'deck.profiles': [] as DeckProfile[] } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: state, commit: (key: keyof typeof state, value: never) => { state[key] = value; } } }));
vi.mock('@/os.js', () => ({}));
import { columns, layout, reloadCurrentDeckProfile, addColumn } from '@/deck.js';

describe('applying imported deck profiles', () => {
	test('replaces live columns before a later edit saves them', () => {
		state['deck.profile'] = 'Imported';
		state['deck.profiles'] = [{ id: 'profile', name: 'Imported', columns: [{ id: 'imported', type: 'tl', name: 'Imported', width: 320 }], layout: [['imported']] }];
		reloadCurrentDeckProfile();
		expect(columns.value.map(column => column.id)).toEqual(['imported']);
		expect(layout.value).toEqual([['imported']]);
		addColumn({ id: 'new', type: 'notifications', name: null, width: 300 });
		expect(state['deck.profiles'][0].columns.map(column => column.id)).toEqual(['imported', 'new']);
	});
	test('creates a saveable Main profile for a source that has never used Deck', () => {
		state['deck.profile'] = null;
		state['deck.profiles'] = [];
		reloadCurrentDeckProfile();
		addColumn({ id: 'new', type: 'tl', name: null, width: 300 });
		expect(state['deck.profile']).toBe('Main');
		expect(state['deck.profiles'][0].columns.map(column => column.id)).toEqual(['new']);
	});
});
