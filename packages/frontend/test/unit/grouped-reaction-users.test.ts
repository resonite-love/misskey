/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import Actions from '@/components/MkGridspaceNoteActions.vue';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {} } }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: {} }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { more: 'More', _gridspace: {} } } }));
vi.mock('@/components/MkPoll.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkReactionsViewer.vue', () => ({ default: { props: ['transport'], template: '<button @click="transport.showUsers([\':cat@.:\', \':cat@g.test:\'])">Reactors</button>' } }));
afterEach(cleanup);

test.each([undefined, 'https://r.test/notes/note'])('a grouped reactor list preserves its channel or guest conversation across pages (%s)', async conversationUri => {
	api.mockClear();
	api.mockImplementation(async (_endpoint: string, input: { reaction: string; untilId?: string }) => {
		const prefix = input.reaction === ':cat@.:' ? 'r' : 'g';
		const n = input.untilId ? 1 : 10;
		return { reactors: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${input.untilId ? 'last' : i}`, account: { uri: `https://g.test/users/${i === 0 ? 'same' : prefix + i}`, username: prefix + (input.untilId ? 'last' : i), host: 'g.test' } })) };
	});
	const note = { id: 'note', origin: 'https://r.test', channelId: 'channel', conversationUri, reactions: {} } as entities.GridspacePrivateNotesResponse['notes'][number];
	const view = render(Actions, { props: { note, compact: true } });
	await fireEvent.click(view.getByText('Reactors'));
	await vi.waitFor(() => expect(view.container.querySelectorAll('a')).toHaveLength(19));
	await fireEvent.click(view.getByText('More'));
	await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(4));
	for (const [, input] of api.mock.calls) {
		expect(input).toMatchObject(conversationUri ? { noteId: 'note', conversationUri } : { noteId: 'note', channelId: 'channel' });
		if (conversationUri) expect(input.channelId).toBeUndefined();
	}
	expect(api.mock.calls.slice(2).map(([, input]) => input)).toEqual([
		expect.objectContaining({ reaction: ':cat@.:', untilId: 'r9' }),
		expect.objectContaining({ reaction: ':cat@g.test:', untilId: 'g9' }),
	]);
	await vi.waitFor(() => expect(view.queryByText('More')).toBeNull());
});

test.each(['AUTHORIZATION_REVOKED', 'ACTION_REJECTED'])('a read denial between pages (%s) removes identities and invalidates the parent view', async reason => {
	api.mockResolvedValue({ reactors: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, account: { uri: `https://g.test/users/${i}`, username: `u${i}`, host: 'g.test' } })) });
	const unavailable = vi.fn();
	const note = { id: 'note', origin: 'https://r.test', channelId: 'channel', reactions: {} } as entities.GridspacePrivateNotesResponse['notes'][number];
	const view = render(Actions, { props: { note, compact: true, onUnavailable: unavailable } });
	await fireEvent.click(view.getByText('Reactors'));
	await vi.waitFor(() => expect(view.container.querySelectorAll('a')).toHaveLength(10));
	api.mockRejectedValue({ info: { reason } });
	await fireEvent.click(view.getByText('More'));
	await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
	expect(view.container.querySelectorAll('a')).toHaveLength(0);
});
