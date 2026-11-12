/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createGridspaceHeaders, GRIDSPACE_CLOCK_SKEW_MS, GRIDSPACE_HANDSHAKE_PATH, resolveGridspaceConfig, verifyGridspaceRequest } from './peer-protocol.js';

const env = { GRIDSPACE_TEST_KEY: randomBytes(32).toString('base64') };
const source = { enabled: true, communityId: 'test', keyId: 'first', secretEnv: 'GRIDSPACE_TEST_KEY', peerUrl: 'https://r.example' };
const g = resolveGridspaceConfig(source, 'https://g.example', env)!;
const r = resolveGridspaceConfig({ ...source, peerUrl: g.origin }, source.peerUrl, env)!;
const body = Buffer.from('{"protocolVersion":1}');
const now = 1_800_000_000_000;

describe('GridSpace peer authentication', () => {
	test('does not enable a missing or disabled configuration', () => {
		expect(resolveGridspaceConfig(undefined, 'http://localhost', {})).toBeNull();
		expect(resolveGridspaceConfig({ ...source, enabled: false }, 'http://localhost', {})).toBeNull();
	});

	test.each(['http://r.example', 'https://r.example/path', 'https://x@y.example', 'https://r.example?key=x', 'https://r.example#fragment', 'https://g.example'])('rejects invalid peer origin %s', peerUrl => {
		expect(() => resolveGridspaceConfig({ ...source, peerUrl }, g.origin, env)).toThrow();
	});

	test('rejects absent or weak secrets without including them in the error', () => {
		expect(() => resolveGridspaceConfig(source, g.origin, {})).toThrow('32-byte');
		expect(() => resolveGridspaceConfig(source, g.origin, { GRIDSPACE_TEST_KEY: 'secret' })).toThrow('32-byte');
	});

	test('authenticates exact bytes for the configured peer and audience', () => {
		const headers = createGridspaceHeaders(g, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, now);
		expect(verifyGridspaceRequest(r, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, headers, now)).toBe(headers['x-gridspace-nonce']);
		expect(verifyGridspaceRequest(g, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, headers, now)).toBeNull();
	});

	test('rejects tampering with the payload, method, path, key or community', () => {
		const headers = createGridspaceHeaders(g, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, now);
		expect(verifyGridspaceRequest(r, 'POST', GRIDSPACE_HANDSHAKE_PATH, Buffer.from('{ "protocolVersion":1}'), headers, now)).toBeNull();
		expect(verifyGridspaceRequest(r, 'GET', GRIDSPACE_HANDSHAKE_PATH, body, headers, now)).toBeNull();
		expect(verifyGridspaceRequest(r, 'POST', '/gridspace/v1/other', body, headers, now)).toBeNull();
		expect(verifyGridspaceRequest({ ...r, keyId: 'rotated' }, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, headers, now)).toBeNull();
		expect(verifyGridspaceRequest({ ...r, communityId: 'other' }, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, headers, now)).toBeNull();
	});

	test('rejects expired and excessively future-dated signatures', () => {
		const headers = createGridspaceHeaders(g, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, now);
		for (const offset of [-GRIDSPACE_CLOCK_SKEW_MS - 1, GRIDSPACE_CLOCK_SKEW_MS + 1]) {
			expect(verifyGridspaceRequest(r, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, headers, now + offset)).toBeNull();
		}
	});

	test('rejects duplicate and malformed headers', () => {
		const headers = createGridspaceHeaders(g, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, now);
		expect(verifyGridspaceRequest(r, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, { ...headers, 'x-gridspace-origin': [g.origin, g.origin] }, now)).toBeNull();
		expect(verifyGridspaceRequest(r, 'POST', GRIDSPACE_HANDSHAKE_PATH, body, { ...headers, 'x-gridspace-signature': 'x' }, now)).toBeNull();
	});
});
