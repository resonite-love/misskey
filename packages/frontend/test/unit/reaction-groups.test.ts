/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { groupReactions, sourceReactionForTransport } from '@/utility/reaction-groups.js';

const aliases = { ':cat@r.test:': ':cat@.:' };
test('only the verified peer emoji joins the local button, preserving both raw sources', () => {
	const groups = groupReactions({ ':cat@r.test:': 2, ':cat@.:': 3, ':cat@third.test:': 1, '👍': 4 }, aliases, 'g.test', 'g.test', { ':cat@r.test:': 'r2' });
	expect(groups).toEqual([
		{ reaction: ':cat@.:', action: ':cat@.:', count: 5, sources: [{ reaction: ':cat@r.test:', count: 2, version: 'r2' }, { reaction: ':cat@.:', count: 3, version: undefined }] },
		{ reaction: ':cat@third.test:', action: ':cat@third.test:', count: 1, sources: [{ reaction: ':cat@third.test:', count: 1, version: undefined }] },
		{ reaction: '👍', action: '👍', count: 4, sources: [{ reaction: '👍', count: 4, version: undefined }] },
	]);
});
test('delegated channel data is source-relative and its fallback action uses the viewing server emoji', () => {
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

test('an aliased peer reaction uses the peer-local key when clicked', () => {
	const [group] = groupReactions(
		{ ':sakamiyurusanai@.:': 2 },
		{ ':sakamiyurusanai@misskey.resonite.love:': ':sakamiyurusanai@.:' },
		'misskey.grid-space.io',
		'misskey.resonite.love',
	);
	expect(group.reaction).toBe(':sakamiyurusanai@.:');
	expect(group.action).toBe(':sakamiyurusanai@misskey.grid-space.io:');
	expect(sourceReactionForTransport(group.sources, 'misskey.resonite.love', group.action)).toBe(':sakamiyurusanai@misskey.resonite.love:');
});

test('an ordinary reaction keeps its action value', () => {
	expect(sourceReactionForTransport([{ reaction: '❤', count: 2 }], 'r.test', '❤')).toBe('❤');
});

test.each([
	['g.test', 'r.test', ':kitten:'],
	['r.test', 'g.test:3000', ':kitten@.:'],
])('a grouped %s viewer sends the %s source-local key %s', (viewer, source, raw) => {
	const [group] = groupReactions({ [`:cat@${viewer}:`]: 1, [raw]: 2 }, { [`:kitten@${source}:`]: ':cat@.:' }, viewer, source);
	expect(group.reaction).toBe(':cat@.:');
	expect(sourceReactionForTransport(group.sources, source, group.action)).toBe(`:kitten@${source}:`);
	expect(group.sources.map(s => s.reaction)).toEqual([`:cat@${viewer}:`, raw]);
});

test('a group without a source-local custom emoji retains its original action', () => {
	expect(sourceReactionForTransport([{ reaction: ':cat@third.test:', count: 1 }], 'r.test', ':cat@third.test:')).toBe(':cat@third.test:');
	expect(sourceReactionForTransport([], 'r.test', '👍')).toBe('👍');
	expect(sourceReactionForTransport([{ reaction: ':cat@.:', count: 1 }], undefined, ':cat@.:')).toBe(':cat@.:');
});
