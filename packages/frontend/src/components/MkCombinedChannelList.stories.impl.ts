/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { markRaw } from 'vue';
import { HttpResponse, http } from 'msw';
import type { StoryObj } from '@storybook/vue3';
import { channel } from '../../.storybook/fakes.js';
import { Paginator } from '@/utility/paginator.js';
import MkCombinedChannelList from './MkCombinedChannelList.vue';

const local = channel();
const remote = { ...channel(), name: 'Shared channel', isOwned: false };
export const Default = {
	render: args => ({
		components: { MkCombinedChannelList },
		setup: () => ({ args, paginator: markRaw(new Paginator('channels/featured', { noPaging: true, minItemsToShow: 1 })) }),
		template: '<MkCombinedChannelList v-bind="args" :paginator="paginator" />',
	}),
	args: { peerEnabled: true, peerParams: { list: 'featured' } },
	parameters: { msw: { handlers: [
		http.post('/api/channels/featured', () => HttpResponse.json([local])),
		http.post('/api/gridspace/channels', () => HttpResponse.json({ origin: 'https://peer.example', channels: [remote], next: null })),
	] } },
} satisfies StoryObj<typeof MkCombinedChannelList>;

export const PeerUnavailable = {
	...Default,
	parameters: { msw: { handlers: [
		http.post('/api/channels/featured', () => HttpResponse.json([local])),
		http.post('/api/gridspace/channels', () => HttpResponse.json({ error: { code: 'GRIDSPACE_CHANNEL_UNAVAILABLE' } }, { status: 503 })),
	] } },
} satisfies StoryObj<typeof MkCombinedChannelList>;
