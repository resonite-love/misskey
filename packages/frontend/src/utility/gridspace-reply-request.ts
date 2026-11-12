/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Only operation identifiers survive navigation; never store text, CW or recipients.
const key = (accountId: string, noteId: string) => `gridspace:reply:${accountId}:${noteId}`;
export function pendingReplyRequest(accountId: string, noteId: string): string | null {
	const value = window.sessionStorage.getItem(key(accountId, noteId));
	return value && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value : null;
}
export function rememberReplyRequest(accountId: string, noteId: string, requestId: string): string {
	const previous = pendingReplyRequest(accountId, noteId);
	if (previous) return previous;
	window.sessionStorage.setItem(key(accountId, noteId), requestId);
	return requestId;
}
export function forgetReplyRequest(accountId: string, noteId: string, requestId: string): void {
	if (pendingReplyRequest(accountId, noteId) === requestId) window.sessionStorage.removeItem(key(accountId, noteId));
}
