/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { canonicalReaction, localReaction, compareReactionRows, encodeReactionPosition, reactionPosition, validateReactionSnapshots, supportsGridspaceReactions, type ReactionSnapshot } from './reaction-protocol.js';
import type { GridspacePeerConfig } from './peer-protocol.js';

const g = 'https://g.example';
const r = 'https://r.example';
const uri = `${r}/notes/abc`;
const snapshot: ReactionSnapshot = { uri, reactions: { '👍': 2 }, reactionEmojis: {}, reactionAcceptance: null, revision: 'a'.repeat(64), rows: [] };

describe('paired reaction wire contract', () => {
	test('bounds and validates authorized batch actor previews', () => {
		const input = { mode: 'show' as const, uris: [uri], withPreviews: true };
		const preview = { reaction: '👍', account: { uri: `${r}/users/u`, username: 'u', host: 'r.example', name: null, avatarUrl: `${r}/avatar.png` } };
		expect(validateReactionSnapshots([{ ...snapshot, previews: [preview] }], input, r)[0].previews).toEqual([preview]);
		for (const previews of [[...Array(21).fill(preview)], [{ ...preview, reaction: 'missing' }], [{ ...preview, account: { ...preview.account, avatarUrl: 'javascript:bad' } }]]) {
			expect(() => validateReactionSnapshots([{ ...snapshot, previews }], input, r)).toThrow();
		}
		expect(() => validateReactionSnapshots([{ ...snapshot, previews: [preview] }], { ...input, withPreviews: false }, r)).toThrow();
	});
	test('uses only the exact peer origin and excludes channels without widening note sharing', () => {
		const peer = { origin: g, peerOrigin: r } as GridspacePeerConfig;
		const note = { userHost: 'r.example', uri, channelId: null };
		expect(supportsGridspaceReactions(note, peer)).toBe(true);
		expect(supportsGridspaceReactions({ ...note, uri: 'https://r.example.evil/notes/abc' }, peer)).toBe(false);
		expect(supportsGridspaceReactions({ ...note, userHost: 'other.example' }, peer)).toBe(false);
		expect(supportsGridspaceReactions({ ...note, channelId: 'channel' }, peer)).toBe(false);
		expect(supportsGridspaceReactions(note, null)).toBe(false);
	});
	test('keeps local, paired and third-server emoji identities distinct', () => {
		expect(canonicalReaction(':same:', g)).toBe(':same@g.example:');
		expect(canonicalReaction(':same@.:', r)).toBe(':same@r.example:');
		expect(canonicalReaction(':same@elsewhere.example:', g)).toBe(':same@elsewhere.example:');
		expect(localReaction(':same@g.example:', g)).toBe(':same@.:');
		expect(localReaction(':same@r.example:', g)).toBe(':same@r.example:');
		expect(localReaction(canonicalReaction('👍', g), r)).toBe('👍');
	});
	test('orders equal-time and equal-id rows deterministically across origins', () => {
		const rows = [{ time: 2, id: 'a', origin: g }, { time: 1, id: 'b', origin: r }, { time: 1, id: 'b', origin: g }, { time: 1, id: 'a', origin: r }];
		expect([...rows].sort(compareReactionRows)).toEqual([rows[3], rows[2], rows[1], rows[0]]);
		for (const row of rows) expect(reactionPosition(encodeReactionPosition(row), [g, r])).toEqual(row);
		expect(reactionPosition('gr1legacyid', [g, r])).toBeUndefined();
		expect(() => reactionPosition(encodeReactionPosition({ ...rows[0], origin: 'https://elsewhere.example' }), [g, r])).toThrow();
		expect(() => reactionPosition(`gr1${'ff'.repeat(30)}`, [g, r])).toThrow();
	});
	test('rejects injected notes, counts, malformed maps, duplicate rows and oversized lists', () => {
		const input = { mode: 'list' as const, uris: [uri], limit: 1 };
		expect(validateReactionSnapshots([snapshot], input, r)).toEqual([snapshot]);
		const versioned = { ...snapshot, reactionVersions: { '👍': 'b'.repeat(32) } };
		expect(validateReactionSnapshots([versioned], input, r)).toEqual([versioned]);
		const row = { time: 1, id: 'abc', origin: r, userUri: `${r}/users/u`, reaction: '👍' };
		for (const changed of [{ uri: `${r}/notes/hidden` }, { reactions: { '👍': -1 } }, { reactions: [] }, { revision: 'bad' }, { reactionVersions: {} }, { reactionVersions: { '👍': 'bad' } }, { reactionVersions: [] }, { rows: [row, row] }, { rows: [{ ...row, origin: g }] }]) {
			expect(() => validateReactionSnapshots([{ ...snapshot, ...changed }], input, r)).toThrow();
		}
		expect(() => validateReactionSnapshots([snapshot, snapshot], { ...input, uris: [uri, `${r}/notes/other`] }, r)).toThrow();
	});
});
