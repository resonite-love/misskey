/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { HttpResponse, http } from 'msw';
import { commonHandlers } from '../../.storybook/mocks.js';
import type { StoryObj } from '@storybook/vue3';
import MkNoteDestinations from './MkNoteDestinations.vue';

const channels = [
	{ id: 'talk', name: '雑談', color: '#6384be', isArchived: false, isSensitive: false, allowRenoteToExternal: true },
	{ id: 'photos', name: '写真', color: '#9c884c', isArchived: false, isSensitive: false, allowRenoteToExternal: true },
];
const peerChannels = [{ ...channels[0], color: '#528a7b' }, { ...channels[1], name: 'イラストや音楽などみんなで楽しむ作品紹介', isSensitive: true }];
export const Default = {
	args: { visibility: 'public', peerEnabled: true, localOrigin: 'https://local.example', modelValue: { includeDefault: true, channels: [] } },
	render: args => ({
		components: { MkNoteDestinations },
		setup: () => ({ args }),
		data: () => ({ selection: args.modelValue }),
		template: '<MkNoteDestinations v-bind="args" v-model="selection"/>',
	}),
	parameters: {
		msw: { handlers: [
			...commonHandlers,
			http.post(/\/api\/channels\/(my-favorites|featured|followed|search)$/, async ({ request }) => {
				const { query = '' } = await request.json() as { query?: string };
				return HttpResponse.json(channels.filter(item => item.name.includes(query)));
			}),
			http.post('/api/gridspace/multi-note/channels', async ({ request }) => {
				const { query = '' } = await request.json() as { query?: string };
				return HttpResponse.json({ enabled: true, origin: 'https://peer.community.example', channels: peerChannels.filter(item => item.name.includes(query)), next: null });
			}),
		] },
	},
} satisfies StoryObj<typeof MkNoteDestinations>;
