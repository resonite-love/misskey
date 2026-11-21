/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { isMisskeyApiNetworkError, misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/i.js', () => ({ $i: null }));
afterEach(() => { vi.restoreAllMocks(); });

test('marks only a rejected fetch as a network error', async () => {
	const failure = new TypeError('Failed to fetch');
	vi.spyOn(window, 'fetch').mockRejectedValue(failure);
	await expect(misskeyApi('meta')).rejects.toBe(failure);
	expect(isMisskeyApiNetworkError(failure)).toBe(true);
});
test.each([null, { error: { code: 'AUTHENTICATION_FAILED' } }])('does not classify HTTP error-body failures as network failures: %j', async body => {
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 401 }));
	const error = await misskeyApi('meta').catch(error => error);
	expect(isMisskeyApiNetworkError(error)).toBe(false);
});
