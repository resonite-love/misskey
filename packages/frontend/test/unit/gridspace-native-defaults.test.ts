/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only */
import { expect, test } from 'vitest';
import { PREF_DEF } from '@/preferences/def.js';
import { parseClientSettings, portableSettingKeys } from '@/utility/gridspace-settings.js';
test('native defaults can be exported for linking', () => {
 const failures:string[] = [];
 for (const key of portableSettingKeys) {
  const source = PREF_DEF[key].default;
  const value = typeof source === 'function' ? source() : source;
  try {parseClientSettings(JSON.stringify({ version: 1, values: { [key]: value } }));} catch(e) {failures.push(key + ': ' + JSON.stringify(value));}
 }
 expect(failures).toEqual([]);
});
