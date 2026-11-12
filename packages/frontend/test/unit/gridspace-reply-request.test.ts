/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { forgetReplyRequest, pendingReplyRequest, rememberReplyRequest } from '@/utility/gridspace-reply-request.js';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
beforeEach(() => window.sessionStorage.clear());

test('navigation and another card retain the same operation, separated by account and note', () => {
	expect(rememberReplyRequest('a', 'note', first)).toBe(first);
	expect(rememberReplyRequest('a', 'note', second)).toBe(first);
	expect(pendingReplyRequest('b', 'note')).toBeNull();
	expect(pendingReplyRequest('a', 'other')).toBeNull();
	forgetReplyRequest('a', 'note', second);
	expect(pendingReplyRequest('a', 'note')).toBe(first);
	forgetReplyRequest('a', 'note', first);
	expect(pendingReplyRequest('a', 'note')).toBeNull();
});

test('only stores the UUID and propagates storage errors before a caller can send', () => {
	rememberReplyRequest('a', 'note', first);
	expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toBe(first);
	const storage = vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue({ getItem: () => null, setItem: () => { throw new Error('unavailable'); } } as unknown as Storage);
	try { expect(() => rememberReplyRequest('a', 'other', second)).toThrow('unavailable'); } finally { storage.mockRestore(); }
});
