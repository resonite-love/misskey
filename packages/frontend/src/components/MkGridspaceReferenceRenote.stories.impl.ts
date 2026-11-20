/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { http, HttpResponse } from 'msw';
import Renote from './MkGridspaceReferenceRenote.vue';
import { Default as Source } from './MkGridspacePrivateNote.stories.impl.js';

export const Default = {
	render: args => ({ components: { Renote }, setup: () => ({ args }), template: '<Renote v-bind="args" />' }),
	args: { note: { user: { id: 'viewer', username: 'viewer', host: null, name: 'Viewer', avatarUrl: '', avatarBlurhash: null, avatarDecorations: [], isBot: false, isCat: false, emojis: {}, onlineStatus: 'unknown' }, createdAt: new Date(0).toISOString(), gridspaceQuote: 'https://example.com/gridspace/private?noteId=note&channelId=channel' } },
	parameters: { msw: { handlers: [http.post('/api/gridspace/note-link', () => HttpResponse.json({ note: { ...Source.args.note, canQuoteOutside: true }, localNote: null }))] } },
} satisfies StoryObj<typeof Renote>;
