/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { StoryObj } from '@storybook/vue3';
import MkNotePlacements from './MkNotePlacements.vue';

export const Default = {
	args: { includeDefault: true, placements: [{ origin: 'https://peer.example', channelId: 'talk', name: '雑談', state: 'pending' }] },
} satisfies StoryObj<typeof MkNotePlacements>;
