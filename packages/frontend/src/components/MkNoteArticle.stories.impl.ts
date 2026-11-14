/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { StoryObj } from '@storybook/vue3';
import { userLite } from '../../.storybook/fakes.js';
import MkNoteArticle from './MkNoteArticle.vue';

export const Default = {
	render: args => ({ components: { MkNoteArticle }, setup: () => ({ args }), template: '<MkNoteArticle v-bind="args"><template #header>表示名 @user</template>チャンネルの投稿本文<template #reactions>👍 2</template><template #footer="{ buttonClass }"><button class="_button" :class="buttonClass">↩</button><button class="_button" :class="buttonClass">＋</button></template></MkNoteArticle>' }),
	args: { user: userLite(), channel: { id: 'channel', name: '#NSFWな話', color: '#ff8a8a' }, avatarPreview: false },
} satisfies StoryObj<typeof MkNoteArticle>;

export const LinkedChannel = { ...Default, args: { ...Default.args, channelTo: '/gridspace/channels/channel' } } satisfies StoryObj<typeof MkNoteArticle>;
export const HoverActions = { ...Default, args: { ...Default.args, footerOnHover: true } } satisfies StoryObj<typeof MkNoteArticle>;
