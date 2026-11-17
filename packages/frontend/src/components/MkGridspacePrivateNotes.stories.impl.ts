/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import { Default as Note } from './MkGridspacePrivateNote.stories.impl.js';
import MkGridspacePrivateNotes from './MkGridspacePrivateNotes.vue';

const grant = http.post('/api/gridspace/private-grant', () => HttpResponse.json({ enabled: true, granted: true, available: true, peerOrigin: 'https://peer.example', authorizationUrl: null, clientKey: null }));
export const Default = {
	render: args => ({ components: { MkGridspacePrivateNotes }, setup: () => ({ args }), template: '<MkGridspacePrivateNotes v-bind="args" />' }),
	args: { params: { mode: 'home' }, alwaysShow: true },
	parameters: { msw: { handlers: [grant, http.post('/api/gridspace/private-notes', () => HttpResponse.json({ notes: [Note.args.note], cursor: null }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;

export const Unavailable = {
	...Default,
	parameters: { msw: { handlers: [grant, http.post('/api/gridspace/private-notes', () => HttpResponse.json({ error: { code: 'GRIDSPACE_PRIVATE_UNAVAILABLE' } }, { status: 403 }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;

export const ConsentRequired = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-grant', () => HttpResponse.json({ enabled: true, granted: false, available: true, peerOrigin: 'https://peer.example', authorizationUrl: null, clientKey: null }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;

export const UnifiedChannel = {
	...Default,
	args: { params: { mode: 'channel', channelId: 'channel' }, alwaysShow: true, plain: true },
	parameters: { msw: { handlers: [
		http.post('/api/gridspace/link', () => HttpResponse.json({ timeline: { version: 1, enabled: true, kinds: ['channel'] } })),
		http.post('/api/gridspace/timeline', () => HttpResponse.json({
			version: 1, session: 'channel', revision: '1', items: [{
				key: Note.args.note.uri, ref: 'channel-note', representation: 'delegated', payload: Note.args.note,
				sortKey: { sortAt: '1', uri: Note.args.note.uri }, validForMs: 10000,
			}], nextCursor: null, updatesCursor: 'head', complete: true, mode: 'unified',
			sources: [{ source: 'peer', status: 'ok', retryable: false }], revalidateAfterMs: 10000,
		})),
	] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;
