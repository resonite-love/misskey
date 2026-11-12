/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import MkGridspaceNotificationRow from './MkGridspaceNotificationRow.vue';
import MkGridspaceNotification from './MkGridspaceNotification.vue';
import { row } from './MkGridspaceNotification.stories.impl.js';
export const Default = {
	render: args => ({ components: { MkGridspaceNotificationRow, MkGridspaceNotification }, setup: () => ({ args }), template: '<MkGridspaceNotificationRow v-bind="args"><MkGridspaceNotification :row="args.row" /></MkGridspaceNotificationRow>' }),
	args: { row },
} satisfies StoryObj<typeof MkGridspaceNotificationRow>;
