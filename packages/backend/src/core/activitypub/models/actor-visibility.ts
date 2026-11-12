/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { IActor } from '../type.js';

function threshold(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('Invalid actor visibility threshold');
	return value;
}

/** Match renderPerson's wire fields for both first resolution and subsequent Updates. */
export function actorVisibility(person: IActor) {
	return {
		requireSigninToViewContents: person._misskey_requireSigninToViewContents === true,
		makeNotesFollowersOnlyBefore: threshold(person._misskey_makeNotesFollowersOnlyBefore),
		makeNotesHiddenBefore: threshold(person._misskey_makeNotesHiddenBefore),
	};
}
