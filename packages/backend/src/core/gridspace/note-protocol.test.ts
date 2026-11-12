/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { canShareGridspaceNote, canonicalGridspaceNoteUri, gridspaceNoteUris, validateGridspaceBundle, type GridspaceNoteBundle } from './note-protocol.js';

const origin = 'https://r.example';
const publicAudience = 'https://www.w3.org/ns/activitystreams#Public';
const bundle = (): GridspaceNoteBundle => ({ deleted: false, notes: [{ localOnly: true, reactionAcceptance: null, object: {
	type: 'Note', id: origin + '/notes/test', attributedTo: origin + '/users/author', to: [publicAudience], cc: [],
} }] });

describe('community note boundary', () => {
	test.each(['public', 'home'])('shares %s but never channel notes', visibility => {
		expect(canShareGridspaceNote({ visibility, channelId: null })).toBe(true);
		expect(canShareGridspaceNote({ visibility, channelId: 'channel' })).toBe(false);
	});
	test.each(['followers', 'specified'])('does not broadcast %s notes', visibility => {
		expect(canShareGridspaceNote({ visibility, channelId: null })).toBe(false);
	});
	test('retains local-only restriction and accepts home audience', () => {
		const value = bundle();
		value.notes[0].object.to = [];
		value.notes[0].object.cc = [publicAudience];
		expect(validateGridspaceBundle(value, origin, 'test').notes[0].localOnly).toBe(true);
	});
	test('rejects private objects even from the authenticated peer', () => {
		const value = bundle(); value.notes[0].object.to = [origin + '/users/author/followers'];
		expect(() => validateGridspaceBundle(value, origin, 'test')).toThrow();
	});
	test.each(['id', 'attributedTo'] as const)('rejects a forged %s', key => {
		const value = bundle(); value.notes[0].object[key] = 'https://external.example/users/other';
		expect(() => validateGridspaceBundle(value, origin, 'test')).toThrow();
	});
	test('rejects duplicate, missing and oversized graphs', () => {
		const value = bundle();
		expect(() => validateGridspaceBundle(value, origin, 'other')).toThrow();
		value.notes.push(value.notes[0]);
		expect(() => validateGridspaceBundle(value, origin, 'test')).toThrow();
		value.notes = Array(65).fill(value.notes[0]);
		expect(() => validateGridspaceBundle(value, origin, 'test')).toThrow();
	});
	test('deletion cannot carry content', () => {
		expect(validateGridspaceBundle({ deleted: true, notes: [] }, origin, 'test').deleted).toBe(true);
		expect(() => validateGridspaceBundle({ ...bundle(), deleted: true }, origin, 'test')).toThrow();
	});
	test('temporary unavailability is distinct from deletion and cannot carry content', () => {
		expect(validateGridspaceBundle({ deleted: false, unavailable: true, notes: [] }, origin, 'test').deleted).toBe(false);
		expect(() => validateGridspaceBundle({ ...bundle(), unavailable: true }, origin, 'test')).toThrow();
		expect(() => validateGridspaceBundle({ deleted: true, unavailable: true, notes: [] }, origin, 'test')).toThrow();
		expect(() => validateGridspaceBundle({ ...bundle(), unavailable: 'true' }, origin, 'test')).toThrow();
	});
});

test('canonicalizes only peer Announce IDs and resolves earlier stored IDs', () => {
	expect(canonicalGridspaceNoteUri(origin + '/notes/test/activity', origin + '/')).toBe(origin + '/notes/test');
	expect(gridspaceNoteUris(origin + '/notes/test', origin)).toEqual([origin + '/notes/test', origin + '/notes/test/activity']);
	expect(canonicalGridspaceNoteUri('https://external.example/notes/test/activity', origin)).toBe('https://external.example/notes/test/activity');
	expect(canonicalGridspaceNoteUri(origin + '/notes/test/activity?other=1', origin)).toBe(origin + '/notes/test/activity?other=1');
});
