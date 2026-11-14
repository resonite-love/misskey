/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkNoteDetailedHeader from './MkNoteDetailedHeader.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkNoteDetailedHeader }, setup: () => ({ args }), template: '<MkNoteDetailedHeader v-bind="args" />' }), args: { 'user': { 'id': 'user', 'name': 'User', 'username': 'user', 'host': null, 'avatarUrl': '/avatar.webp', 'avatarBlurhash': null, 'avatarDecorations': [], 'emojis': {}, 'onlineStatus': 'unknown' }, 'visibility': 'public' } } satisfies StoryObj<typeof MkNoteDetailedHeader>;
