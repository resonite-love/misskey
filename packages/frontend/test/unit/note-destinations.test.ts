/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, ref } from 'vue';
import MkNoteDestinations from '@/components/MkNoteDestinations.vue';
import { initialDestinations } from '@/utility/multi-note.js';

const { api, popupMenu } = vi.hoisted(() => ({ api: vi.fn(), popupMenu: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class {} }));
vi.mock('@/os.js', () => ({ popupMenu }));
vi.mock('@/i18n.js', () => ({ i18n: {
	ts: { inUse: 'In use', search: 'Search', favorites: 'Favorites', loadMore: 'More', noResults: 'None', retry: 'Retry', somethingHappened: 'Failed to load channels', _gridspace: { channelSensitive: 'Sensitive channel' }, _channel: { featured: 'Featured', following: 'Following' },
		_multiNote: { localSiteName: 'れぞらぶ', peerSiteName: 'ぐりすぺ', destinations: 'Destinations', chooseChannels: 'Choose channels', defaultDestination: 'Regular', channelList: 'List', partnerServer: 'Peer', requiresPublic: 'Choose public visibility', noDestinations: 'Select a destination', channelOnly: 'Channels only' } },
	tsx: { _multiNote: { removeSelection: ({ name }: { name: string }) => 'Remove ' + name } },
} }));

const localOrigin = 'https://local.example';
const peerOrigin = 'https://peer.example';
const peerEndpoint = 'gridspace/multi-note/channels';
const channel = (id: string, name = id) => ({ id, name, color: '#ccc', isArchived: false, isSensitive: false });
const peerPage = (channels: ReturnType<typeof channel>[], next: string | null = null) => ({ enabled: true, origin: peerOrigin, channels, next });

function picker(props: { peerEnabled?: boolean; token?: string; disabled?: boolean } = {}) {
	return render(defineComponent({
		components: { MkNoteDestinations },
		props: { peerEnabled: Boolean, token: String, disabled: Boolean },
		setup: () => ({ model: ref(initialDestinations()), localOrigin }),
		template: '<MkNoteDestinations v-model="model" visibility="home" :localOrigin="localOrigin" :peerEnabled="peerEnabled" :token="token" :disabled="disabled"/>',
	}), { props: { peerEnabled: true, ...props }, global: { stubs: { MkLoading: true }, directives: { adaptiveBorder: {} } } });
}

beforeEach(() => {
	api.mockReset();
	popupMenu.mockReset();
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens both favorites together and independently selects same-ID channels without changing visibility', async () => {
	const talk = channel('same', 'Talk');
	api.mockImplementation(async (path: string) => path === peerEndpoint ? peerPage([{ ...talk, isSensitive: true }]) : [talk]);
	const view = picker({ token: 'account' });
	await fireEvent.click(view.getByRole('button', { name: 'Choose channels' }));
	expect(view.getByRole('button', { name: 'List · Favorites' }).getAttribute('aria-haspopup')).toBe('menu');
	expect(api).toHaveBeenCalledWith('channels/my-favorites', {}, 'account');
	expect(api).toHaveBeenCalledWith(peerEndpoint, expect.objectContaining({ list: 'favorite' }), 'account');
	const local = await view.findByRole('checkbox', { name: 'Talk れぞらぶ' });
	const peer = await view.findByRole('checkbox', { name: 'Talk ぐりすぺ Sensitive channel' });
	expect(local.closest('label')?.querySelector('small')?.title).toBe(localOrigin);
	expect(peer.closest('label')?.querySelector('small')?.title).toBe(peerOrigin);
	await fireEvent.click(local);
	await fireEvent.click(peer);
	expect(view.getByText('Choose public visibility')).toBeTruthy();
	expect((view.getByRole('checkbox', { name: 'Regular' }) as HTMLInputElement).checked).toBe(true);
	await fireEvent.click(view.getByRole('checkbox', { name: 'Regular' }));
	await fireEvent.click(view.getByRole('button', { name: 'Remove Talk · れぞらぶ' }));
	expect((view.getByRole('checkbox', { name: /Talk ぐりすぺ/ }) as HTMLInputElement).checked).toBe(true);
	await fireEvent.click(view.getByRole('button', { name: 'Remove Talk · ぐりすぺ' }));
	expect(view.getByText('Select a destination')).toBeTruthy();
});

it.each(['local', 'peer'])('keeps the successful candidates while retrying only the failed %s source', async failed => {
	const failedPath = failed === 'peer' ? peerEndpoint : 'channels/my-favorites';
	const readySite = failed === 'peer' ? 'れぞらぶ' : 'ぐりすぺ';
	let rejectPage!: (error: Error) => void;
	api.mockImplementation(async (path: string) => {
		if (path === failedPath && !rejectPage) return new Promise((_, reject) => { rejectPage = reject; });
		return path === peerEndpoint ? peerPage([channel('Talk')]) : [channel('Talk')];
	});
	const view = picker();
	await fireEvent.click(view.getByRole('button', { name: 'Choose channels' }));
	await fireEvent.click(await view.findByRole('checkbox', { name: 'Talk ' + readySite }));
	rejectPage(new Error('offline'));
	expect((await view.findByText('Failed to load channels')).getAttribute('role')).toBe('status');
	expect(view.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
	await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
	await waitFor(() => expect(view.getAllByRole('checkbox', { name: /Talk/ })).toHaveLength(2));
	expect((view.getByRole('checkbox', { name: 'Talk ' + readySite }) as HTMLInputElement).checked).toBe(true);
	expect(api.mock.calls.filter(([path]) => path === failedPath)).toHaveLength(2);
	expect(api.mock.calls.filter(([path]) => path !== failedPath)).toHaveLength(1);
});

it('loads both origins from one button and retries only failures while retaining results and independent cursors', async () => {
	const firstLocal = Array.from({ length: 20 }, (_, n) => channel('local-' + n));
	let failPeerMore = true;
	let rejectPeerMore!: (error: Error) => void;
	api.mockImplementation(async (path, params) => {
		if (path === 'channels/my-favorites') return [];
		if (path === 'channels/search') return params.untilId ? [firstLocal[19], channel('local-next')] : firstLocal;
		if (params.list === 'favorite' || !params.query) return peerPage([]);
		if (!params.before) return peerPage([channel('Peer talk')], 'peer-cursor');
		if (params.before === 'peer-next-cursor') return peerPage([]);
		if (failPeerMore) {
			failPeerMore = false;
			return new Promise((_, reject) => { rejectPeerMore = reject; });
		}
		return peerPage([channel('Peer talk'), channel('Peer next')], 'peer-next-cursor');
	});
	const view = picker();
	await fireEvent.click(view.getByRole('button', { name: 'Choose channels' }));
	await fireEvent.click(await view.findByRole('button', { name: 'Search' }));
	await fireEvent.update(view.getByLabelText('Search'), '  music ');
	await view.findByRole('checkbox', { name: 'Peer talk ぐりすぺ' });
	await fireEvent.click(view.getByRole('checkbox', { name: 'Peer talk ぐりすぺ' }));
	expect(api).toHaveBeenCalledWith('channels/search', expect.objectContaining({ query: 'music' }), undefined);
	expect(api).toHaveBeenCalledWith(peerEndpoint, expect.objectContaining({ list: 'search', query: 'music' }), undefined);
	expect(view.getAllByRole('button', { name: 'More' })).toHaveLength(1);
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	await view.findByRole('checkbox', { name: 'local-next れぞらぶ' });
	const more = view.getByRole('button', { name: 'More' });
	expect((more as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.click(more);
	expect(api.mock.calls.filter(([path, params]) => path === peerEndpoint && params.before)).toHaveLength(1);
	rejectPeerMore(new Error('offline'));
	await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
	await view.findByRole('checkbox', { name: 'Peer next ぐりすぺ' });
	expect((view.getByRole('checkbox', { name: 'Peer talk ぐりすぺ' }) as HTMLInputElement).checked).toBe(true);
	expect(view.getAllByRole('checkbox', { name: 'Peer talk ぐりすぺ' })).toHaveLength(1);
	expect(view.getAllByRole('checkbox', { name: 'local-19 れぞらぶ' })).toHaveLength(1);
	expect(api.mock.calls.filter(([path, params]) => path === peerEndpoint && params.before === 'peer-cursor')).toHaveLength(2);
	expect(api).toHaveBeenCalledWith('channels/search', { limit: 20, query: 'music', untilId: 'local-19' }, undefined);
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	await waitFor(() => expect(view.queryByRole('button', { name: 'More' })).toBeNull());
	expect(api.mock.calls.filter(([path, params]) => path === 'channels/search' && params.untilId)).toHaveLength(1);
	expect(api).toHaveBeenCalledWith(peerEndpoint, expect.objectContaining({ before: 'peer-next-cursor' }), undefined);
});

it('keeps paging a healthy source when its peer is unavailable, then retries without reloading exhausted pages', async () => {
	const firstLocal = Array.from({ length: 20 }, (_, n) => channel('local-' + n));
	api.mockImplementation(async (path, params) => {
		if (path === 'channels/my-favorites') return [];
		if (path === 'channels/search') return !params.query ? [] : params.untilId ? [channel('local-next')] : firstLocal;
		if (params.list === 'favorite' || !params.query) return peerPage([]);
		throw new Error('peer unavailable');
	});
	const view = picker();
	await fireEvent.click(view.getByRole('button', { name: 'Choose channels' }));
	await fireEvent.click(await view.findByRole('button', { name: 'Search' }));
	await fireEvent.update(view.getByLabelText('Search'), 'news');
	await view.findByText('Failed to load channels');
	await fireEvent.click(view.getByRole('checkbox', { name: 'local-0 れぞらぶ' }));
	expect(view.getAllByRole('button', { name: 'More' })).toHaveLength(1);
	expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	await view.findByRole('checkbox', { name: 'local-next れぞらぶ' });
	await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
	await view.findByRole('button', { name: 'Retry' });
	expect((view.getByRole('checkbox', { name: 'local-0 れぞらぶ' }) as HTMLInputElement).checked).toBe(true);
	expect(api.mock.calls.filter(([path, params]) => path === 'channels/search' && params.untilId)).toHaveLength(1);
	expect(api.mock.calls.filter(([path, params]) => path === peerEndpoint && params.query === 'news')).toHaveLength(3);
});

it('discards previous filter and account responses and removes peer candidates when capability is disabled', async () => {
	const previous: (() => void)[] = [];
	api.mockImplementation(async (path, _params, token) => {
		const page = (name: string) => path === peerEndpoint ? peerPage([channel(name)]) : [channel(name)];
		if (token === 'old') return new Promise(resolve => previous.push(() => resolve(page('Stale'))));
		return page('Current');
	});
	const view = picker({ token: 'old' });
	await fireEvent.click(view.getByRole('button', { name: 'Choose channels' }));
	await fireEvent.click(view.getByRole('button', { name: 'List · Favorites' }));
	const [items, , menu] = popupMenu.mock.lastCall!;
	expect(items.filter((item: { caption?: string }) => item.caption)).toEqual([expect.objectContaining({ text: 'Favorites', caption: 'In use' })]);
	items.find((item: { text: string }) => item.text === 'Following').action();
	menu.onClosing();
	expect(previous).toHaveLength(4);
	await view.rerender({ token: 'new', peerEnabled: true });
	await view.findByRole('checkbox', { name: 'Current ぐりすぺ' });
	previous.forEach(resolve => resolve());
	await view.rerender({ token: 'new', peerEnabled: false });
	await view.findByRole('checkbox', { name: 'Current れぞらぶ' });
	expect(view.queryByRole('checkbox', { name: /Stale|ぐりすぺ/ })).toBeNull();
	expect(api.mock.calls.filter(([path, , token]) => path === peerEndpoint && token === 'new')).toHaveLength(1);
	expect(api).toHaveBeenCalledWith('channels/followed', expect.anything(), 'new');
});

it('disables picker controls with the composer and makes no peer request in local-only mode', async () => {
	api.mockResolvedValue([]);
	const view = picker({ peerEnabled: false });
	await fireEvent.click(view.getByRole('button', { name: 'Choose channels' }));
	await view.findByRole('button', { name: 'Search' });
	await view.rerender({ peerEnabled: false, disabled: true });
	expect((view.getByRole('button', { name: 'List · Favorites' }) as HTMLButtonElement).disabled).toBe(true);
	expect(view.getByRole('button', { name: 'Choose channels' }).closest('fieldset')?.disabled).toBe(true);
	expect(api.mock.calls.map(([path]) => path)).toEqual(['channels/my-favorites']);
});
