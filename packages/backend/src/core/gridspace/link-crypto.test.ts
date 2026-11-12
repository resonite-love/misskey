/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { gridspaceChallenge, openGridspaceSecret, sealGridspaceSecret } from './link-crypto.js';
import type { GridspacePeerConfig } from './peer-protocol.js';

const config: GridspacePeerConfig = { origin: 'https://g.example', peerOrigin: 'https://r.example', communityId: 'test', keyId: 'first', secret: Buffer.alloc(32, 7) };

describe('GridSpace OAuth credentials', () => {
	test('uses the RFC 7636 S256 challenge vector', () => {
		expect(gridspaceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});
	test('encrypts each credential with a fresh nonce and binds it to the link', () => {
		const first = sealGridspaceSecret(config, 'credential', 'link-1');
		const second = sealGridspaceSecret(config, 'credential', 'link-1');
		expect(first).not.toBe(second);
		expect(first).not.toContain('credential');
		expect(openGridspaceSecret(config, first, 'link-1')).toBe('credential');
		expect(() => openGridspaceSecret(config, first, 'link-2')).toThrow();
		expect(() => openGridspaceSecret({ ...config, origin: config.peerOrigin }, first, 'link-1')).toThrow();
	});
	test('rejects tampered and truncated ciphertext', () => {
		const value = Buffer.from(sealGridspaceSecret(config, 'credential', 'link-1'), 'base64url');
		value[value.length - 1] ^= 1;
		expect(() => openGridspaceSecret(config, value.toString('base64url'), 'link-1')).toThrow();
		expect(() => openGridspaceSecret(config, 'invalid', 'link-1')).toThrow();
	});
});
