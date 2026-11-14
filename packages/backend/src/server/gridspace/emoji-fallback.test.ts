/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import type { GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';
import { peerEmojiFallback } from './emoji-fallback.js';

const peer = { peerOrigin: 'https://source.example' } as GridspacePeerConfig;

describe('paired emoji cache misses', () => {
	test('uses the source-local emoji path with no remote host suffix or redirect loop', () => {
		expect(peerEmojiFallback(peer, 'blobcatbook', 'source.example', {})).toBe('https://source.example/emoji/blobcatbook.webp');
		expect(peerEmojiFallback(peer, 'blobcatbook', undefined, {})).toBeNull();
	});
	test('preserves static and badge rendering', () => {
		expect(peerEmojiFallback(peer, 'blobcatbook', 'source.example', { static: '', badge: '' })).toBe('https://source.example/emoji/blobcatbook.webp?static=1&badge=1');
	});
	test('preserves the placeholder when the source emoji is also missing', () => {
		expect(peerEmojiFallback(peer, 'missing', 'source.example', { fallback: '' })).toBe('https://source.example/emoji/missing.webp?fallback=1');
	});
	test.each([undefined, '.', 'other.example', 'source.example.attacker.example'])('leaves ordinary local and federated lookups unchanged (%s)', host => {
		expect(peerEmojiFallback(peer, 'blobcatbook', host, {})).toBeNull();
	});
	test('does not accept a disabled pair or arbitrary path', () => {
		expect(peerEmojiFallback(null, 'blobcatbook', 'source.example', {})).toBeNull();
		for (const name of ['../other', 'emoji@other.example', '', 'emoji?url=bad']) expect(peerEmojiFallback(peer, name, 'source.example', {})).toBeNull();
	});
});
