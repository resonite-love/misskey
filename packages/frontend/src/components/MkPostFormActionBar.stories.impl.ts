/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkPostFormActionBar from './MkPostFormActionBar.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkPostFormActionBar }, setup: () => ({ args }), template: '<MkPostFormActionBar v-bind="args" />' }), args: { 'poll': false, 'useCw': false } } satisfies StoryObj<typeof MkPostFormActionBar>;
