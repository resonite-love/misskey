/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { parseGridspacePalette } from './palette-protocol.js';

const palette = { version: 1, palettes: [{ id: 'one', name: 'よく使う', emojis: ['😀', ':resonite:', ':remote@example.net:'] }], forMain: 'one', forReaction: null };

test('copies only palette data without changing names, order or emoji references', () => {
	const parsed = parseGridspacePalette({ ...palette, token: 'not a palette preference' });
	expect(parsed).toEqual(palette);
	expect(parsed?.palettes).not.toBe(palette.palettes);
});

test.each([
	null, {}, { ...palette, version: 2 }, { ...palette, forMain: 'absent' },
	{ ...palette, palettes: [palette.palettes[0], palette.palettes[0]] },
	{ ...palette, palettes: [{ ...palette.palettes[0], emojis: [42] }] },
	{ ...palette, palettes: [{ ...palette.palettes[0], emojis: Array(10001).fill('😀') }] },
	{ ...palette, palettes: [{ ...palette.palettes[0], emojis: Array(2000).fill('😀'.repeat(100)) }] },
])('rejects malformed, ambiguous or oversized palette data', value => {
	expect(parseGridspacePalette(value)).toBeNull();
});
