/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkNoteCw from './MkNoteCw.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkNoteCw }, setup: () => ({ args }), template: '<MkNoteCw v-bind="args" />' }), args: { 'cw': 'CW', 'text': 'Note', 'modelValue': false } } satisfies StoryObj<typeof MkNoteCw>;
