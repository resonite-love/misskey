/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import fetch, { AbortError, FetchError } from 'node-fetch';
import { GridspaceLinkService } from './GridspaceLinkService.js';

vi.mock('node-fetch', async importOriginal => ({ ...await importOriginal<typeof import('node-fetch')>(), default: vi.fn() }));
vi.mock('./peer-client.js', () => ({ gridspacePeerTransport: () => ({ url: 'https://peer.example/test', host: 'peer.example' }) }));

test.each([
	{ status: undefined, error: new FetchError('socket', 'system', { code: 'ECONNRESET' } as NodeJS.ErrnoException), retryable: true },
	{ status: 200, error: new FetchError('socket', 'system', { code: 'ECONNRESET' } as NodeJS.ErrnoException), retryable: true },
	{ status: 200, error: new FetchError('gzip', 'system', { code: 'Z_DATA_ERROR' } as NodeJS.ErrnoException), retryable: false },
	{ status: 401, error: new FetchError('socket', 'system', { code: 'ECONNRESET' } as NodeJS.ErrnoException), retryable: false },
	{ status: 401, error: new AbortError('abort'), retryable: false },
	{ status: 200, error: new SyntaxError('JSON'), retryable: false },
])('classifies transport independently of HTTP and body errors: $status / $retryable', async ({ status, error, retryable }) => {
	const request = vi.mocked(fetch); request.mockReset();
	if (status == null) request.mockRejectedValue(error);
	else request.mockResolvedValue({ status, ok: status === 200, json: async () => { throw error; } } as never);
	const service = Object.assign(Object.create(GridspaceLinkService.prototype), { peer: {} }) as GridspaceLinkService;
	await expect(service.json('/test', {}, false)).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE', retryable });
});
