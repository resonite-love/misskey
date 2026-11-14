/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkPostFormHeader from './MkPostFormHeader.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkPostFormHeader }, setup: () => ({ args }), template: '<MkPostFormHeader v-bind="args" />' }), args: {} } satisfies StoryObj<typeof MkPostFormHeader>;
