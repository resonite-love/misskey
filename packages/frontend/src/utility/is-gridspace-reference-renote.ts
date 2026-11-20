/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function isGridspaceReferenceRenote(note: { gridspaceQuote?: string | null; text?: string | null; cw?: string | null; files?: unknown[]; poll?: unknown; replyId?: string | null }) {
	return !!note.gridspaceQuote && !note.text && note.cw == null && !note.files?.length && !note.poll && !note.replyId;
}
