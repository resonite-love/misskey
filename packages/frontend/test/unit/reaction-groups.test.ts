/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { groupReactions } from '@/utility/reaction-groups.js';

const aliases = { ':cat@r.test:': ':cat@.:' };
test('only the verified peer emoji joins the local button, preserving both raw sources', () => {
	const groups = groupReactions({ ':cat@r.test:': 2, ':cat@.:': 3, ':cat@third.test:': 1, '👍': 4 }, aliases, 'g.test', 'g.test', { ':cat@r.test:': 'r2' });
	expect(groups).toEqual([
		{ reaction: ':cat@.:', action: ':cat@.:', count: 5, sources: [{ reaction: ':cat@r.test:', count: 2, version: 'r2' }, { reaction: ':cat@.:', count: 3, version: undefined }] },
		{ reaction: ':cat@third.test:', action: ':cat@third.test:', count: 1, sources: [{ reaction: ':cat@third.test:', count: 1, version: undefined }] },
		{ reaction: '👍', action: '👍', count: 4, sources: [{ reaction: '👍', count: 4, version: undefined }] },
	]);
});
test('delegated channel data is source-relative while adding uses the viewing server emoji', () => {
	const [group] = groupReactions({ ':cat@.:': 2, ':cat@g.test:': 3 }, aliases, 'g.test', 'r.test');
	expect(group.reaction).toBe(':cat@.:');
	expect(group.action).toBe(':cat@g.test:');
	expect(group.count).toBe(5);
	expect(group.sources.map(source => source.reaction)).toEqual([':cat@.:', ':cat@g.test:']);
});
test('unsynced same-name emojis, unicode and other servers stay separate in either direction', () => {
	expect(groupReactions({ ':cat@r.test:': 1, ':cat@.:': 1 }, {}, 'g.test')).toHaveLength(2);
	expect(groupReactions({ ':cat@g.test:': 1, ':cat@.:': 1 }, { ':cat@g.test:': ':cat@.:' }, 'r.test')).toHaveLength(1);
	const delegated = groupReactions({ ':cat@.:': 2, ':cat@g.test:': 3 }, {}, 'g.test', 'r.test');
	expect(delegated).toHaveLength(2);
	expect(delegated[0]).toMatchObject({ reaction: ':cat@r.test:', action: ':cat@r.test:', count: 2 });
});
