/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createGridspacePreferenceReader } from '@/utility/gridspace-settings.js';
const same = (a: { account?: string | null }, b: { account?: string | null }) => a.account === b.account;
test('loads once across palette and settings and does not mix account scopes', async() => {
 const load = vi.fn(async() => ({ 'default:animation': [[{ account: 'other' }, true], [{ account: 'selected' }, false]], 'default:emojiPalettes': [[{ account: 'selected' }, []]] }));
 const read = createGridspacePreferenceReader(load, same);
 const [animation, palettes] = await Promise.all([read('animation', { account: 'selected' }), read('emojiPalettes', { account: 'selected' })]);
 expect(animation).toEqual({ value: false }); expect(palettes).toEqual({ value: [] });
 expect(await read('missing', { account: 'selected' })).toBeNull();
 expect(load).toHaveBeenCalledTimes(1);
});
test('a failed attempt can be retried with a fresh reader', async() => {
 const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
 const first = createGridspacePreferenceReader(load, same);
 await expect(first('animation', {})).rejects.toThrow('offline');
 expect(await createGridspacePreferenceReader(load, same)('animation', {})).toBeNull();
 expect(load).toHaveBeenCalledTimes(2);
});
