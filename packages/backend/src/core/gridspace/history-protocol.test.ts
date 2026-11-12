/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { decodeHistoryCursor, encodeHistoryCursor, mergeHistory, validateHistoryPage, type HistoryItem } from './history-protocol.js';

const peer = { origin: 'https://g.example', peerOrigin: 'https://r.example', communityId: 'lab', keyId: 'v1', secret: randomBytes(32) };

describe('linked history keysets', () => {
	test('pages unequal streams and equal timestamps without skipping or repeating items', () => {
		const local = [{ id: 'd', date: 100 }, { id: 'c', date: 100 }, { id: 'b', date: 90 }, { id: 'a', date: 50 }];
		const remote = [{ id: 'd', date: 100 }, { id: 'c', date: 95 }, { id: 'b', date: 90 }];
		const actual: string[] = [];
		let l: string | null = null; let r: string | null = null;
		for (let page = 0; page < 10; page++) {
			const items = mergeHistory(local.filter(x => l == null || x.id < l).slice(0, 2), remote.filter(x => r == null || x.id < r).slice(0, 2), 2);
			if (items.length === 0) break;
			for (const item of items) {
				actual.push(`${item.source}:${item.id}`);
				if (item.source === 'local') l = item.id; else r = item.id;
			}
		}
		expect(actual).toEqual(['local:d', 'local:c', 'remote:d', 'remote:c', 'local:b', 'remote:b', 'local:a']);
	});

	test('cursor binds profile, viewer, options and link generation', () => {
		const context = JSON.stringify(['profile', 'viewer', 'link', 1, { withFiles: false }]);
		const position = { local: 'abc', remote: null, localHead: 'def', remoteHead: null, expires: Date.now() + 60000 };
		const cursor = encodeHistoryCursor(peer, position, context);
		expect(decodeHistoryCursor(peer, cursor, context)).toEqual(position);
		for (const altered of ['otherProfile', 'otherViewer', 'otherLink', 'otherGeneration', 'otherOptions']) {
			expect(() => decodeHistoryCursor(peer, cursor, context + altered)).toThrow();
		}
		expect(() => decodeHistoryCursor(peer, cursor.slice(0, -5), context)).toThrow();
		expect(() => decodeHistoryCursor(peer, encodeHistoryCursor(peer, { ...position, expires: 1 }, context), context)).toThrow();
	});

	test('rejects unordered, duplicate, invalid and over-limit peer pages', () => {
		const valid = { active: true, items: [{ id: 'b', date: 100 }, { id: 'a', date: 90 }] };
		expect(validateHistoryPage(valid, 2, 'c')).toEqual(valid);
		const invalid: HistoryItem[][] = [valid.items.toReversed(), [valid.items[0], valid.items[0]], [{ id: '../x', date: 90 }], [{ id: 'a', date: NaN }]];
		for (const items of invalid) expect(() => validateHistoryPage({ active: true, items }, 2)).toThrow();
		expect(() => validateHistoryPage(valid, 1)).toThrow();
		expect(() => validateHistoryPage(valid, 2, 'b')).toThrow();
		expect(() => validateHistoryPage({ ...valid, active: false }, 2)).toThrow();
	});
});
