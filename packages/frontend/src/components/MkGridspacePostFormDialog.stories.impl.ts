/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { Default as Form } from './MkGridspacePostForm.stories.impl.js';
import MkGridspacePostFormDialog from './MkGridspacePostFormDialog.vue';

export const Default = {
	render: args => ({ components: { MkGridspacePostFormDialog }, setup: () => ({ args }), template: '<MkGridspacePostFormDialog v-bind="args" />' }),
	args: { channelId: 'channel1', channel: { name: '雑談', color: '#86b300' } },
	parameters: Form.parameters,
} satisfies StoryObj<typeof MkGridspacePostFormDialog>;
