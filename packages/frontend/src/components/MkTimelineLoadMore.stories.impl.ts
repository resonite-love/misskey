/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { StoryObj } from '@storybook/vue3';
import { action } from 'storybook/actions';
import MkTimelineLoadMore from './MkTimelineLoadMore.vue';

export const Default = {
	render: args => ({ components: { MkTimelineLoadMore }, setup: () => ({ args }), template: '<div style="height: 240px; overflow: auto;"><div style="height: 480px;"></div><MkTimelineLoadMore v-bind="args" /></div>' }),
	args: { hasMore: true, loading: false, onLoad: action('load') },
} satisfies StoryObj<typeof MkTimelineLoadMore>;
