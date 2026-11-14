/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** A stripped peer reference can leave a wrapper without any renderable content. */
export function isUnavailableGridspaceNote(note: {
 gridspaceShared?: boolean; isHidden?: boolean; text?: string | null; cw?: string | null;
 fileIds?: readonly string[]; files?: readonly unknown[]; poll?: unknown;
 replyId?: string | null; renoteId?: string | null; renote?: unknown;
}, linkedPrivate = false): boolean {
 return (linkedPrivate || note.gridspaceShared === true) && !note.isHidden &&
  note.text == null && note.cw == null && !note.fileIds?.length && !note.files?.length &&
  note.poll == null && note.replyId == null && note.renoteId == null && note.renote == null;
}
