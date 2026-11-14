/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import FollowButton from '@/components/MkChannelFollowButton.vue';
import ChannelPage from '@/pages/gridspace-channels.vue';

const { api, alert, confirm } = vi.hoisted(() => ({ api: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ alert, confirm }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { showFixedPostFormInChannel: false } } }));
vi.mock('@/utility/device-kind.js', () => ({ deviceKind: 'desktop' }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { setItemAsJson: vi.fn() } }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: vi.fn() }));
vi.mock('@/components/MkGridspacePrivateNotes.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkGridspacePostForm.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkInput.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { follow: 'Follow', unfollow: 'Unfollow', processing: 'Working', favorite: 'Favorite', unfavorite: 'Unfavorite', unfavoriteConfirm: 'Remove?', _gridspace: { connectionError: 'Failed' }, _channel: {} }, tsx: { _channel: { usersCount: () => '', notesCount: () => '' } } } }));

const globals = { stubs: { MkLoading: true, MkA: true, Mfm: true, PageWithHeader: { emits: ['update:tab'], template: '<div><button @click="$emit(\'update:tab\', \'overview\')">Overview</button><slot/></div>' } }, directives: { tooltip: () => {} } };
beforeEach(() => { vi.clearAllMocks(); confirm.mockResolvedValue({ canceled: false }); });
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
