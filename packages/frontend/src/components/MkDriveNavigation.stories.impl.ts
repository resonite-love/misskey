/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkDriveNavigation from './MkDriveNavigation.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkDriveNavigation }, setup: () => ({ args }), template: '<MkDriveNavigation v-bind="args" />' }), args: {} } satisfies StoryObj<typeof MkDriveNavigation>;
