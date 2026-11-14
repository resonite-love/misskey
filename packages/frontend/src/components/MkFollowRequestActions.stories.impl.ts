/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkFollowRequestActions from './MkFollowRequestActions.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkFollowRequestActions }, setup: () => ({ args }), template: '<MkFollowRequestActions v-bind="args" />' }), args: { 'busy': false } } satisfies StoryObj<typeof MkFollowRequestActions>;
