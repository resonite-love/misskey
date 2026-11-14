/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkChannelOverview from './MkChannelOverview.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkChannelOverview }, setup: () => ({ args }), template: '<MkChannelOverview v-bind="args" />' }), args: { 'channel': { 'name': 'Channel', 'description': 'Channel description', 'bannerUrl': null, 'usersCount': 10, 'notesCount': 100, 'isSensitive': false } } } satisfies StoryObj<typeof MkChannelOverview>;
