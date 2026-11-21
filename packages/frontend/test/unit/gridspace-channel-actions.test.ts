/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import FollowButton from '@/components/MkChannelFollowButton.vue';
import ChannelPage from '@/pages/gridspace-channels.vue';
import LocalChannelPage from '@/pages/channel.vue';
import { url } from '@@/js/config.js';

const { api, alert, confirm, post } = vi.hoisted(() => ({ api: vi.fn(), alert: vi.fn(), confirm: vi.fn(), post: vi.fn() }));
const { features } = vi.hoisted(() => ({ features: { multiNotePeer: false } }));
vi.mock('@/instance.js', () => ({ instance: { features } }));
vi.mock('@/components/MkFoldableSection.vue', () => ({ default: { template: '<section><slot/></section>' } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ alert, confirm, post }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer' }, iAmModerator: false }));
vi.mock('@/router.js', () => ({ useRouter: () => ({}) }));
vi.mock('@/cache.js', () => ({ favoritedChannelsCache: {} }));
vi.mock('@/utility/paginator.js', () => ({ Paginator: class {} }));
vi.mock('@/utility/check-permissions.js', () => ({ notesSearchAvailable: true }));
vi.mock('@/components/MkNote.vue', () => ({ default: {} }));
vi.mock('@/components/MkPostForm.vue', () => ({ default: {} }));
vi.mock('@/components/MkNotesTimeline.vue', () => ({ default: {} }));
vi.mock('@/components/MkStreamingNotesTimeline.vue', () => ({ default: {} }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { showFixedPostFormInChannel: false }, r: { showFixedPostFormInChannel: { value: false } } } }));
vi.mock('@/utility/device-kind.js', () => ({ deviceKind: 'desktop' }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { setItemAsJson: vi.fn() } }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: post }));
vi.mock('@/components/MkGridspacePrivateNotes.vue', () => ({ default: { props: ['params', 'channelOrigin', 'pinnedOnly'], template: '<div :data-origin="channelOrigin" :data-channel="params.channelId" :data-pins="pinnedOnly"/>' } }));
vi.mock('@/components/MkGridspacePostForm.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkInput.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { postToTheChannel: 'Post to channel', sensitive: 'Sensitive', follow: 'Follow', unfollow: 'Unfollow', processing: 'Working', favorite: 'Favorite', unfavorite: 'Unfavorite', unfavoriteConfirm: 'Remove?', _gridspace: { connectionError: 'Failed' }, _channel: {} }, tsx: { _channel: { usersCount: () => '', notesCount: () => '' } } } }));

const globals = { stubs: { MkLoading: true, MkA: true, Mfm: true, PageWithHeader: { emits: ['update:tab'], template: '<div><button @click="$emit(\'update:tab\', \'overview\')">Overview</button><button @click="$emit(\'update:tab\', \'timeline\')">Timeline</button><slot/><slot name="footer"/></div>' } }, directives: { tooltip: () => {} } };
beforeEach(() => { vi.clearAllMocks(); features.multiNotePeer = false; confirm.mockResolvedValue({ canceled: false }); });
afterEach(cleanup);

test('ordinary follow buttons retain the normal API', async () => {
	api.mockResolvedValue({});
	const view = render(FollowButton, { props: { channel: { id: 'local', isFollowing: false }, full: true }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Follow' }));
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Unfollow' })).toBeTruthy());
	expect(api).toHaveBeenCalledWith('channels/follow', { channelId: 'local' });
});

test('custom follow request cannot update another channel after navigation', async () => {
	let resolve!: (value: boolean) => void;
	const request = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
	const view = render(FollowButton, { props: { channel: { id: 'old', isFollowing: false }, full: true, updateFollowing: request }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Follow' }));
	await view.rerender({ channel: { id: 'new', isFollowing: false } }); resolve(true);
	await vi.waitFor(() => expect((view.getByRole('button', { name: 'Follow' }) as HTMLButtonElement).disabled).toBe(false));
	expect(api).not.toHaveBeenCalled();
});

test('linked channel overview follows and favorites independently and preserves state on failure', async () => {
	let isFollowing = false, isFavorited = false, fail = false;
	api.mockImplementation(async (path: string, params: { action?: string }) => {
		if (path === 'gridspace/channels') return { origin: 'https://r.example', next: null, channels: [{ id: 'channel', name: 'Test channel', isFollowing, isFavorited, isArchived: false }] };
		if (fail) throw new Error('offline');
		if (params.action === 'follow') isFollowing = true;
		if (params.action === 'unfollow') isFollowing = false;
		if (params.action === 'favorite') isFavorited = true;
		if (params.action === 'unfavorite') isFavorited = false;
		return { isFollowing, isFavorited };
	});
	const view = render(ChannelPage, { props: { channelId: 'channel' }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Overview' }));
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Follow' })).toBeTruthy());
	await fireEvent.click(view.getByRole('button', { name: 'Follow' }));
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Unfollow' })).toBeTruthy());
	await fireEvent.click(view.getByRole('button', { name: 'Favorite' }));
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Unfavorite' })).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/channel-update', { channelId: 'channel', action: 'favorite' }, undefined, expect.anything());
	fail = true; await fireEvent.click(view.getByRole('button', { name: 'Unfavorite' }));
	await vi.waitFor(() => expect(alert).toHaveBeenCalledWith({ type: 'error', text: 'Failed' }));
	expect(view.getByRole('button', { name: 'Unfavorite' })).toBeTruthy();
	await vi.waitFor(() => expect((view.getByRole('button', { name: 'Unfavorite' }) as HTMLButtonElement).disabled).toBe(false));
	fail = false; await fireEvent.click(view.getByRole('button', { name: 'Unfavorite' }));
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Favorite' })).toBeTruthy());
});

test.each([[true, false], [false, false], [true, true], [false, true]])('paired channel uses its own timeline and pins (writing %s, sensitive %s)', async (enabled, isSensitive) => {
	features.multiNotePeer = enabled;
	const origin = 'https://pair.example';
	api.mockImplementation(async (path: string, params) => {
		if (path === 'gridspace/link') return { channelsEnabled: false, timeline: { version: 1, enabled: true, kinds: ['channel'], channelPlacements: true } };
		if (path === 'gridspace/multi-note/channel-update') return { isFavorited: true, isFollowing: false };
		if (path === 'gridspace/multi-note/channels' && params.list === undefined) return { origin, channels: [{ id: 'sameId', name: 'New channel', isSensitive, isFollowing: false, isFavorited: false, isArchived: false }], next: null };
		throw new Error(`Unexpected request ${path}`);
	});
	const view = render(ChannelPage, { props: { channelId: 'sameId', placement: '1' }, global: globals });
	await vi.waitFor(() => expect(view.container.querySelector('[data-channel="sameId"]')?.getAttribute('data-origin')).toBe(origin));
	const compose = view.queryByRole('button', { name: 'Post to channel' });
	if (enabled) {
		expect(compose).toBeTruthy();
		await fireEvent.click(compose!);
		expect(post).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'sameId', channelOrigin: origin }), expect.any(Function));
	} else {
		expect(compose).toBeNull();
	}
	await fireEvent.click(view.getByRole('button', { name: 'Overview' }));
	if (isSensitive) expect(view.getByText('Sensitive')).toBeTruthy();
	expect(view.container.querySelector('[data-pins]')?.getAttribute('data-origin')).toBe(origin);
	await fireEvent.click(view.getByRole('button', { name: 'Favorite' }));
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/multi-note/channel-update', { channelId: 'sameId', action: 'favorite' }, undefined, expect.anything()));
});

test('local sensitive channel exposes its timeline, pins and composer', async () => {
	const channel = { id: 'local', name: 'Local channel', isSensitive: true, hasPlacementPins: true };
	api.mockResolvedValue(channel);
	const view = render(LocalChannelPage, { props: { channelId: channel.id }, global: globals });
	await vi.waitFor(() => expect(view.container.querySelector('[data-pins]')?.getAttribute('data-origin')).toBe(url));
	expect(view.getByText('Sensitive')).toBeTruthy();
	await fireEvent.click(view.getByRole('button', { name: 'Timeline' }));
	expect(view.container.querySelector('[data-channel="local"]')?.getAttribute('data-origin')).toBe(url);
	await fireEvent.click(view.getByRole('button', { name: 'Post to channel' }));
	expect(post).toHaveBeenCalledWith({ channel });
});
