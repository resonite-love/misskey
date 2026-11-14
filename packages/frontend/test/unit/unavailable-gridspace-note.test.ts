/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { isUnavailableGridspaceNote } from '@/utility/is-unavailable-gridspace-note.js';

const missing = { gridspaceShared: true, text: null, cw: null, files: [], fileIds: [], poll: null, replyId: null, renoteId: null };
test('shows a placeholder for a stripped shared reference, including old imported rows', () => {
 expect(isUnavailableGridspaceNote(missing)).toBe(true);
 expect(isUnavailableGridspaceNote({ ...missing, gridspaceShared: false }, true)).toBe(true);
});
test.each([
 { text: 'Hello' }, { text: '' }, { cw: '' }, { files: [{ id: 'file' }] }, { fileIds: ['file'] },
 { poll: { choices: [] } }, { replyId: 'reply' }, { renoteId: 'renote' }, { renote: { id: 'renote' } },
 { gridspaceShared: false }, { isHidden: true },
])('preserves valid content and existing privacy/deleted-reference UI: %j', fields => {
 expect(isUnavailableGridspaceNote({ ...missing, ...fields })).toBe(false);
});
