/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import Detail from '@/components/MkGridspaceNoteDetail.vue';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { enablePullToRefresh: false, animation: false, enableInfiniteScroll: true } } }));
vi.mock('@@/js/scroll.js', () => ({ isHeadVisible: () => false, onScrollTop: () => () => {}, scrollToTop: vi.fn() }));
vi.mock('@/components/MkGridspacePrivateNoteRow.vue', () => ({ default: { props: ['note', 'detailed'], template: '<div data-row>{{ note.text ?? "suspended" }}<span v-if="detailed">detail</span></div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/components/MkNoteClips.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkTimelineNoteRow.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPullToRefresh.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { channel: 'Channel', loadMore: 'More', noNotes: 'None', retry: 'Retry', newNote: 'New', _gridspace: { newerChannelNotes: 'Later in channel', olderChannelNotes: 'Earlier in channel', newerUserNotes: 'Later by user', olderUserNotes: 'Earlier by user', privateTitle: 'Linked notes', privateUnavailable: 'Unavailable', channelNotesUnavailable: 'Unavailable' } } } }));

const note = (id: string) => ({ id, text: id, uri: `https://r.example/notes/${id}`, createdAt: '2026-11-15T00:00:00Z', channelId: 'channel', author: { username: 'author' }, files: [], cw: null });
const page = (ids: string[], cursor: string | null = null) => ({ notes: ids.map(note), cursor, observedAt: '2026-11-15T00:00:00Z', scannedThrough: null });
const global = { stubs: { MkLoading: true, MkA: true } };

beforeEach(() => {
	api.mockReset();
	vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
	Object.defineProperty(document, 'hidden', { configurable: true, value: false });
	api.mockImplementation(async (_path, input) => {
		if (input.mode === 'show') return page([input.noteId]);
		if (input.mode === 'validate') return page(input.ids);
		if (input.contextScope === 'channel') return input.order === 'oldest' ? input.cursor ? page(['n5']) : page(['n3', 'n4'], 'next-newer') : page(['n1']);
		return page(['user-note']);
	});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('opens channel posts on both sides of the anchor and keeps nearest newer posts beside it', async () => {
	const view = render(Detail, { props: { noteId: 'n2', channelId: 'channel' }, global });
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Later in channel' })).toBeTruthy());
	await fireEvent.click(view.getByRole('button', { name: 'Later in channel' }));
	await vi.waitFor(() => expect(view.getByText('n3')).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/private-notes', expect.objectContaining({ mode: 'context', contextScope: 'channel', noteId: 'n2', channelId: 'channel', order: 'oldest' }), undefined, expect.anything());
	expect([...view.container.querySelectorAll('[data-row]')].map(row => row.textContent)).toEqual(['n4', 'n3', 'n2detail']);
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	await vi.waitFor(() => expect(view.getByText('n5')).toBeTruthy());
	expect([...view.container.querySelectorAll('[data-row]')].map(row => row.textContent)).toEqual(['n5', 'n4', 'n3', 'n2detail']);
	await fireEvent.click(view.getByRole('button', { name: 'Earlier in channel' }));
	await vi.waitFor(() => expect(view.getByText('n1')).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/private-notes', expect.objectContaining({ mode: 'context', contextScope: 'channel', order: 'newest', noteId: 'n2' }), undefined, expect.anything());
	expect([...view.container.querySelectorAll('[data-row]')].map(row => row.textContent)).toEqual(['n5', 'n4', 'n3', 'n2detail', 'n1']);
});

test('author navigation keeps the channel authorization anchor and resets when following a different timestamp link', async () => {
	const view = render(Detail, { props: { noteId: 'n2', channelId: 'channel' }, global });
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Later by user' })).toBeTruthy());
	await fireEvent.click(view.getByRole('button', { name: 'Later by user' }));
	await vi.waitFor(() => expect(view.getByText('user-note')).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/private-notes', expect.objectContaining({ contextScope: 'user', noteId: 'n2', channelId: 'channel', order: 'oldest' }), undefined, expect.anything());
	await view.rerender({ noteId: 'other', channelId: 'channel' });
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Later by user' })).toBeTruthy());
	expect(view.queryByText('user-note')).toBeNull();
});

test('hiding the tab removes all displayed bodies and navigation until authorization returns', async () => {
	const view = render(Detail, { props: { noteId: 'n2', channelId: 'channel' }, global });
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Earlier in channel' })).toBeTruthy());
	await fireEvent.click(view.getByRole('button', { name: 'Earlier in channel' }));
	await vi.waitFor(() => expect(view.getByText('n1')).toBeTruthy());
	Object.defineProperty(document, 'hidden', { configurable: true, value: true });
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(view.queryByText('n1')).toBeNull());
	expect(view.queryByText('n2detail')).toBeNull();
	expect(view.queryByRole('button', { name: 'Later by user' })).toBeNull();
});
