/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import ChannelColumn from '@/ui/deck/channel-column.vue';
import { getDeckChannelChoices, getFavoriteChannelChoices } from '@/utility/deck-channel-choices.js';

const { api, favorites, select, update, post, sharedPost, refresh, fixed } = vi.hoisted(() => ({
	api: vi.fn(), favorites: vi.fn(), select: vi.fn(), update: vi.fn(), post: vi.fn(), sharedPost: vi.fn(), refresh: vi.fn(), fixed: { value: false },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/cache.js', () => ({ favoritedChannelsCache: { fetch: favorites } }));
vi.mock('@/deck.js', () => ({ updateColumn: update }));
vi.mock('@/os.js', () => ({ select, post }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: sharedPost }));
vi.mock('@/preferences.js', () => ({ prefer: { r: { showFixedPostFormInChannel: fixed } } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { note: 'Post', retry: 'Retry', selectChannel: 'Select channel', thisChannelArchived: 'Archived', _gridspace: { channelsUnavailable: 'Channel unavailable', resoniteLoveName: 'れぞらぶ' }, _deck: { _columns: { channel: 'Channel' }, newNoteNotificationSettings: 'Sound' } } } }));
vi.mock('@/ui/deck/tl-note-notification.js', () => ({ soundSettingsButton: vi.fn() }));
vi.mock('@/ui/deck/column.vue', () => ({ default: { props: ['menu'], template: '<section><slot name="header"/><button @click="menu[0].action()">Choose</button><slot/></section>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<aside><slot/></aside>' } }));
vi.mock('@/components/MkPostForm.vue', () => ({ default: { template: '<div>Local composer</div>' } }));
vi.mock('@/components/MkStreamingNotesTimeline.vue', () => ({ default: { props: ['channel'], template: '<div>Local: {{ channel }}</div>' } }));
vi.mock('@/components/MkGridspacePostForm.vue', () => ({ default: { props: ['channelId'], emits: ['sent'], template: '<button @click="$emit(\'sent\')">Send: {{ channelId }}</button>' } }));
vi.mock('@/components/MkGridspacePrivateNotes.vue', async () => {
	const { defineComponent, inject } = await import('vue');
	const { DI } = await import('@/di.js');
	return { default: defineComponent({
		props: ['params'],
		setup(_props, { expose }) { expose({ refresh }); return { linked: inject(DI.linkedChannel) }; },
		template: '<div>Shared: {{ params.channelId }} {{ linked?.name }}</div>',
	}) };
});

const peerChannel = { id: 'same-id', name: 'Source favorite', color: '#123456', isArchived: false };
const peerPage = { origin: 'https://misskey.resonite.love', channels: [peerChannel], next: null };
const column = { id: 'column', type: 'channel' as const, name: null, width: 330, channelId: 'gridspace:channel:same-id' };

beforeEach(() => {
	vi.resetAllMocks();
	fixed.value = false;
	favorites.mockResolvedValue([{ id: 'same-id', name: 'Local favorite' }]);
	api.mockImplementation(async (path: string) => {
		if (path === 'gridspace/link') return { channelsEnabled: true };
		if (path === 'gridspace/channels') return peerPage;
		if (path === 'channels/show') return { id: 'local', name: 'Local channel' };
		throw new Error(`Unexpected API: ${path}`);
	});
});
afterEach(cleanup);

describe('Deck channel choices', () => {
	test('timeline favorites open on the correct server and keep independent read markers', async () => {
		const choices = await getFavoriteChannelChoices();
		expect(choices.map(({ id, to, lastReadKey }) => ({ id, to, lastReadKey }))).toEqual([
			{ id: 'same-id', to: '/channels/same-id', lastReadKey: 'channelLastReadedAt:same-id' },
			{ id: 'gridspace:channel:same-id', to: '/gridspace/channels/same-id', lastReadKey: 'channelLastReadedAt:https://misskey.resonite.love:same-id' },
		]);
	});
	test('timeline favorites refresh paired changes on the next menu opening', async () => {
		expect(await getFavoriteChannelChoices()).toHaveLength(2);
		api.mockImplementation(async (path: string) => path === 'gridspace/link' ? { channelsEnabled: true } : { ...peerPage, channels: [] });
		expect(await getFavoriteChannelChoices()).toHaveLength(1);
	});
	test('includes both servers and distinguishes colliding IDs', async () => {
		expect(await getDeckChannelChoices()).toEqual([
			{ id: 'same-id', name: 'Local favorite', label: 'Local favorite' },
			{ id: 'gridspace:channel:same-id', name: 'Source favorite', label: 'Source favorite（れぞらぶ）' },
		]);
	});
	test('reads all favorite pages using the source API limit', async () => {
		api.mockImplementation(async (path: string, params: { before?: string }) => path === 'gridspace/link' ? { channelsEnabled: true } : params.before ? { ...peerPage, channels: [{ ...peerChannel, id: 'second' }] } : { ...peerPage, next: 'cursor' });
		expect(await getDeckChannelChoices()).toHaveLength(3);
		expect(api).toHaveBeenCalledWith('gridspace/channels', { list: 'favorites', limit: 20, before: 'cursor' });
	});
	test('keeps local choices when the peer is unavailable', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		api.mockRejectedValue(new Error('offline'));
		expect(await getDeckChannelChoices()).toEqual([{ id: 'same-id', name: 'Local favorite', label: 'Local favorite' }]);
		vi.restoreAllMocks();
	});
	test('does not query channels on a server without channel sharing', async () => {
		api.mockResolvedValue({ channelsEnabled: false });
		expect(await getDeckChannelChoices()).toHaveLength(1);
		expect(api).toHaveBeenCalledTimes(1);
	});
});

describe('Deck paired channel column', () => {
	test('selects a source favorite and saves its namespaced ID', async () => {
		select.mockResolvedValue({ canceled: false, result: 'gridspace:channel:same-id' });
		const view = render(ChannelColumn, { props: { column: { ...column, channelId: 'local' }, isStacked: false } });
		await fireEvent.click(view.getByText('Choose'));
		await vi.waitFor(() => expect(update).toHaveBeenCalledWith('column', { channelId: 'gridspace:channel:same-id', timelineNameCache: 'Source favorite' }));
		expect(select.mock.calls[0][0].items).toContainEqual({ value: 'gridspace:channel:same-id', label: 'Source favorite（れぞらぶ）' });
	});
	test('loads source metadata for note rendering and posts to the source channel', async () => {
		const view = render(ChannelColumn, { props: { column, isStacked: false } });
		await vi.waitFor(() => expect(view.getByText('Shared: same-id Source favorite')).toBeTruthy());
		expect(api).not.toHaveBeenCalledWith('channels/show', expect.anything());
		await fireEvent.click(view.getByRole('button', { name: 'Post' }));
		expect(sharedPost).toHaveBeenCalledWith({ channelId: 'same-id', channel: peerChannel }, expect.any(Function));
		sharedPost.mock.calls[0][1]();
		expect(refresh).toHaveBeenCalledOnce();
	});
	test('uses the fixed source composer and refreshes after sending', async () => {
		fixed.value = true;
		const view = render(ChannelColumn, { props: { column, isStacked: false } });
		await vi.waitFor(() => expect(view.getByText('Send: same-id')).toBeTruthy());
		await fireEvent.click(view.getByText('Send: same-id'));
		expect(refresh).toHaveBeenCalledOnce();
	});
	test('does not offer posting to an archived source channel', async () => {
		api.mockResolvedValue({ ...peerPage, channels: [{ ...peerChannel, isArchived: true }] });
		const view = render(ChannelColumn, { props: { column, isStacked: false } });
		await vi.waitFor(() => expect(view.getByText('Archived')).toBeTruthy());
		expect(view.queryByRole('button', { name: 'Post' })).toBeNull();
	});
	test('recovers posting after a metadata failure using the column retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		api.mockRejectedValueOnce(new Error('offline'));
		const view = render(ChannelColumn, { props: { column, isStacked: false } });
		await vi.waitFor(() => expect(view.getByText('Channel unavailable')).toBeTruthy());
		expect(view.queryByRole('button', { name: 'Post' })).toBeNull();
		await fireEvent.click(view.getByText('Retry'));
		await vi.waitFor(() => expect(view.getByRole('button', { name: 'Post' })).toBeTruthy());
		expect(view.queryByText('Channel unavailable')).toBeNull();
		expect(refresh).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
	test('ignores a late source response after switching back to a local channel', async () => {
		let resolveSource!: (value: typeof peerPage) => void;
		api.mockImplementation((path: string) => path === 'gridspace/channels' ? new Promise(resolve => { resolveSource = resolve; }) : Promise.resolve({ id: 'local', name: 'Local channel' }));
		const view = render(ChannelColumn, { props: { column, isStacked: false } });
		await view.rerender({ column: { ...column, channelId: 'local' } });
		resolveSource(peerPage);
		await vi.waitFor(() => expect(view.getByText('Local: local')).toBeTruthy());
		expect(update).not.toHaveBeenCalledWith('column', { timelineNameCache: 'Source favorite' });
		expect(view.queryByText('Shared: same-id Source favorite')).toBeNull();
	});
});
