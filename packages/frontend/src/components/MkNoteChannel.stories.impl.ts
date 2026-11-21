/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { StoryObj } from '@storybook/vue3';
import MkNoteChannel from './MkNoteChannel.vue';

export const Default = {
	render: args => ({ components: { MkNoteChannel }, setup: () => ({ args }), template: '<div style="position: relative; padding: 28px 32px;"><MkNoteChannel v-bind="args" /></div>' }),
	args: { channel: { id: 'channel1', name: '#NSFWな話', color: '#ff8a8a' } },
} satisfies StoryObj<typeof MkNoteChannel>;

export const LinkedChannel = {
	...Default,
	args: { ...Default.args, to: '/gridspace/channels/channel1' },
} satisfies StoryObj<typeof MkNoteChannel>;

export const ColorBar = {
	...Default,
	args: { ...Default.args, display: 'bar' },
} satisfies StoryObj<typeof MkNoteChannel>;

export const ThreeChannelColors = {
	...ColorBar,
	args: {
		...ColorBar.args,
		placements: ['#ff8a8a', '#86b300', '#5b9bd5'].map((color, index) => ({ origin: 'https://example.com', channelId: `channel${index}`, color, state: 'active' as const })),
	},
} satisfies StoryObj<typeof MkNoteChannel>;
