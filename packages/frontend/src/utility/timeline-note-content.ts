/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Compare the rendered body without turning live reaction counts into remounts. */
export function timelineNoteContent(note: unknown): string {
	return JSON.stringify(note, (key, value) => [
		'reactions', 'reactionCount', 'reactionEmojis', 'myReaction', 'myReactions',
		'reactionVersion', 'reactionVersions', 'renoteCount', 'repliesCount', 'votes', 'isVoted',
	].includes(key) ? undefined : value);
}
