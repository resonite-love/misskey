/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkPostFormFields from './MkPostFormFields.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkPostFormFields }, setup: () => ({ args }), template: '<MkPostFormFields v-bind="args" />' }), args: { 'useCw': false } } satisfies StoryObj<typeof MkPostFormFields>;
