/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkDriveGrid from './MkDriveGrid.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkDriveGrid }, setup: () => ({ args }), template: '<MkDriveGrid v-bind="args" />' }), args: {} } satisfies StoryObj<typeof MkDriveGrid>;
