/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { instance } from '@/instance.js';
import { mainRouter } from '@/router.js';
import { makeHotkey } from '@/utility/hotkey.js';
import { postFromHotkey } from '@/utility/post-from-hotkey.js';

const mocks = vi.hoisted(() => ({
	user: { id: 'user' } as { id: string } | null,
	apiWithDialog: vi.fn(),
	misskeyApi: vi.fn(),
	alert: vi.fn(),
	post: vi.fn(),
	gridspacePost: vi.fn(),
}));

vi.mock('@/instance.js', () => ({ instance: { features: { multiNote: true, multiNotePeer: true } } }));
vi.mock('@/i.js', () => ({ get $i() { return mocks.user; } }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, alert: mocks.alert, post: mocks.post }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: mocks.gridspacePost }));
vi.mock('@/router.js', async () => {
	const { Nirax } = await import('@/lib/nirax.js');
	return {
		mainRouter: new Nirax([
			{ path: '/', component: {} },
			{ path: '/channels', component: {} },
			{ path: '/channels/new', component: {} },
			{ path: '/channels/:channelId/edit', component: {} },
			{ path: '/channels/:channelId', component: {} },
			{ path: '/gridspace/channels/:channelId?', query: { placement: 'placement' }, component: {} },
		], '/', true, {}),
	};
});

function pressN(): Promise<void> {
	let result = Promise.resolve();
	makeHotkey({
		n: () => {
			result = postFromHotkey();
		},
	})(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
	return result;
}

describe('N key post destination', () => {
	const channel = { id: 'channel-a', name: 'Channel A', color: '#000000', isSensitive: false, allowRenoteToExternal: true, userId: null };

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.user = { id: 'user' };
		instance.features!.multiNotePeer = true;
		mocks.apiWithDialog.mockResolvedValue(channel);
		mocks.misskeyApi.mockResolvedValue(channel);
		mainRouter.replaceByPath('/');
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	test('opens a post addressed to the displayed channel', async () => {
		mainRouter.replaceByPath('/channels/channel-a');

		await pressN();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('channels/show', { channelId: 'channel-a' });
		expect(mocks.post).toHaveBeenCalledExactlyOnceWith({ channel });
	});

	test('does not display loading or success dialogs when opening a channel post', async () => {
		mainRouter.replaceByPath('/channels/channel-a');

		await pressN();

		expect(mocks.apiWithDialog).not.toHaveBeenCalled();
		expect(mocks.alert).not.toHaveBeenCalled();
		expect(mocks.post).toHaveBeenCalledExactlyOnceWith({ channel });
	});

	test.each(['/', '/channels', '/channels/new', '/channels/channel-a/edit', '/gridspace/channels'])('opens a normal post on %s', async (path) => {
		mainRouter.replaceByPath(path);

		await pressN();

		expect(mocks.misskeyApi).not.toHaveBeenCalled();
		expect(mocks.post).toHaveBeenCalledExactlyOnceWith();
	});

	test('opens the linked channel composer from N without opening a local post', async () => {
		mainRouter.replaceByPath('/gridspace/channels/channel-a');
		mocks.misskeyApi.mockResolvedValue({ origin: 'https://peer.test', channels: [channel] });
		await pressN();
		expect(mocks.misskeyApi).toHaveBeenCalledWith('gridspace/channels', { channelId: 'channel-a' });
		expect(mocks.gridspacePost).toHaveBeenCalledExactlyOnceWith({ channelId: 'channel-a', channel, channelOrigin: 'https://peer.test' });
		expect(mocks.post).not.toHaveBeenCalled();
	});

	test.each([true, false])('uses the peer placement channel for an explicit or reverse placement account (explicit=%s)', async explicit => {
		mainRouter.replaceByPath('/gridspace/channels/channel-a' + (explicit ? '?placement=1' : ''));
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'gridspace/link'
			? { channelsEnabled: false, timeline: { version: 1, enabled: true, kinds: ['channel'], channelPlacements: true } }
			: { origin: 'https://peer.test', channels: [channel] });
		await pressN();
		expect(mocks.misskeyApi).toHaveBeenCalledWith('gridspace/multi-note/channels', { channelId: 'channel-a' });
		expect(mocks.gridspacePost).toHaveBeenCalledExactlyOnceWith({ channelId: 'channel-a', channel, channelOrigin: 'https://peer.test' });
	});

	test('keeps a read-only placement route from opening the legacy composer', async () => {
		instance.features!.multiNotePeer = false;
		mainRouter.replaceByPath('/gridspace/channels/channel-a?placement=1');
		await pressN();
		expect(mocks.gridspacePost).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
		expect(mocks.alert).toHaveBeenCalledOnce();
	});

	test('does not open a stale linked channel after navigating away', async () => {
		let resolveChannels!: (value: { channels: typeof channel[] }) => void;
		mocks.misskeyApi.mockReturnValue(new Promise(resolve => { resolveChannels = resolve; }));
		mainRouter.replaceByPath('/gridspace/channels/channel-a');
		const pending = pressN();
		mainRouter.replaceByPath('/gridspace/channels/channel-b');
		resolveChannels({ channels: [channel] });
		await pending;
		expect(mocks.gridspacePost).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
	});

	test.each([{ channels: [] }, { channels: [{ ...channel, isArchived: true }] }, { channels: [{ ...channel, id: 'another-channel' }] }])('does not open an unavailable linked channel: %j', async ({ channels }) => {
		mainRouter.replaceByPath('/gridspace/channels/channel-a');
		mocks.misskeyApi.mockResolvedValue({ channels });
		await pressN();
		expect(mocks.gridspacePost).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
		expect(mocks.alert).toHaveBeenCalledOnce();
	});

	test('reports a linked channel lookup failure without falling back to a local post', async () => {
		mainRouter.replaceByPath('/gridspace/channels/channel-a');
		mocks.misskeyApi.mockRejectedValue(new Error('Peer unavailable'));
		await pressN();
		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'error', text: 'Peer unavailable' });
		expect(mocks.gridspacePost).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
	});

	test('uses the newly displayed channel after navigation', async () => {
		mainRouter.replaceByPath('/channels/channel-a');
		await pressN();
		const nextChannel = { ...channel, id: 'channel-b', name: 'Channel B' };
		mocks.misskeyApi.mockResolvedValue(nextChannel);
		mainRouter.replaceByPath('/channels/channel-b');

		await pressN();

		expect(mocks.misskeyApi).toHaveBeenLastCalledWith('channels/show', { channelId: 'channel-b' });
		expect(mocks.post).toHaveBeenLastCalledWith({ channel: nextChannel });
	});

	test('does not open a stale channel post if navigation occurs while loading', async () => {
		let resolveChannel!: (value: typeof channel) => void;
		mocks.misskeyApi.mockReturnValue(new Promise(resolve => { resolveChannel = resolve; }));
		mainRouter.replaceByPath('/channels/channel-a');
		const pending = pressN();

		mainRouter.replaceByPath('/channels/channel-b');
		resolveChannel(channel);
		await pending;

		expect(mocks.post).not.toHaveBeenCalled();
	});

	test('does not fall back to a normal post when loading the channel fails', async () => {
		mainRouter.replaceByPath('/channels/channel-a');
		mocks.misskeyApi.mockRejectedValue(new Error('Channel unavailable'));

		await pressN();

		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'error', text: 'Channel unavailable' });
		expect(mocks.post).not.toHaveBeenCalled();
	});

	test('does not open a post while signed out', async () => {
		mainRouter.replaceByPath('/channels/channel-a');
		mocks.user = null;

		await pressN();

		expect(mocks.misskeyApi).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
	});

	test.each(['input', 'textarea'])('does not intercept typing in a %s', async (tagName) => {
		mainRouter.replaceByPath('/channels/channel-a');
		const input = document.createElement(tagName);
		document.body.appendChild(input);
		input.focus();

		await pressN();

		expect(mocks.misskeyApi).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
	});
});
