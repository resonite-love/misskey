/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { actorVisibility } from './actor-visibility.js';
import type { IActor } from '../type.js';

describe('actor visibility wire fields', () => {
	test('reads the same prefixed fields that Misskey publishes', () => {
		expect(actorVisibility({ _misskey_requireSigninToViewContents: true, _misskey_makeNotesFollowersOnlyBefore: -86400, _misskey_makeNotesHiddenBefore: 1700000000 } as IActor)).toEqual({
			requireSigninToViewContents: true, makeNotesFollowersOnlyBefore: -86400, makeNotesHiddenBefore: 1700000000,
		});
	});
	test('allows an Update to clear restrictions', () => {
		expect(actorVisibility({} as IActor)).toEqual({ requireSigninToViewContents: false, makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: null });
	});
	test.each([NaN, Infinity, '123', true, {}, 1.5, 2147483648, -2147483649])('rejects invalid thresholds instead of silently removing restrictions: %j', value => {
		expect(() => actorVisibility({ _misskey_makeNotesHiddenBefore: value } as IActor)).toThrow();
	});
});
