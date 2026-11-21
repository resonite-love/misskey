/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { h } from 'vue';
import { compileTemplate, parse } from 'vue/compiler-sfc';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import NoteText from '@/components/MkNoteText.vue';
import NoteArticle from '@/components/MkNoteArticle.vue';
import NoteDetailedArticle from '@/components/MkNoteDetailedArticle.vue';
import NotePlacements from '@/components/MkNotePlacements.vue';
import nativeSource from '@/components/MkNote.vue?raw';
import detailSource from '@/components/MkNoteDetailed.vue?raw';

vi.mock('@/components/global/MkAvatar.vue', () => ({ default: { props: ['user', 'preview'], template: '<div data-avatar :data-preview="preview">{{ user.username }}</div>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _multiNote: { placements: 'Destinations', defaultDestination: 'Regular timeline' } } } }));
afterEach(cleanup);
const user = { id: 'user', username: 'user', host: null } as entities.UserLite;
const channel = { id: 'channel', name: 'Channel name', color: '#ff8a8a' };
const global = { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' } } };

test.each([
	['MkNote.vue', nativeSource],
	['MkNoteDetailed.vue', detailSource],
])('%s shows verified placements on a public peer mirror without channel context and keeps footer actions', async (filename, source) => {
	const compiled = compileTemplate({ source: parse(source).descriptor.template!.content, filename, id: 'native-article-test', compilerOptions: { mode: 'function', prefixIdentifiers: true } });
	expect(compiled.errors).toEqual([]);
	const reply = vi.fn();
	const origin = 'https://source.example';
	const canonicalUri = origin + '/notes/original';
	const note = {
		id: 'local-mirror', uri: canonicalUri + '/activity', createdAt: '2026-11-14T00:00:00Z',
		user: { ...user, host: 'source.example' }, channelId: null, channel: null, text: 'Native body', cw: null, files: [], visibility: 'public',
		multiNoteKind: 'root', includeDefault: true,
		channelPlacements: ['General', 'Music'].map(name => ({ origin, canonicalUri, channelId: name.toLowerCase(), name, color: '#ffaabb', state: 'active' })),
	} satisfies Partial<entities.Note>;
	const Native = Vue.defineComponent({ render: new Function('Vue', compiled.code)(Vue), setup: () => ({
		hardMuted: false, hideByPlugin: false, muted: false, prefer: { s: {} }, keymap: {}, isRenote: false, renoteCollapsed: false,
		note, appearNote: note, inChannel: null, notePage: () => '/notes/local-mirror', mock: true, showContent: true, canRenote: true, reply, isUnavailableGridspaceNote: () => false, i18n: { ts: {} },
	}) });
	const view = render(Native, { global: {
		...global, mocks: { $style: {}, $appearNote: {} }, directives: { hotkey: {} }, components: { MkNoteArticle: NoteArticle, MkNoteDetailedArticle: NoteDetailedArticle, MkNotePlacements: NotePlacements, MkNoteText: NoteText },
		stubs: { ...global.stubs, MkNoteSub: true, MkNoteHeader: true, MkNoteDetailedHeader: true, MkNoteInfo: true, MkNoteChannel: true, MkReactionsViewer: true,
			MkAutoTranslatedNote: { props: ['note'], template: '<slot :text="note.text" :translated="false"/>' }, Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } },
	} });
	const article = view.getByRole('article');
	expect(article.contains(view.getByText('Regular timeline'))).toBe(true);
	for (const name of ['General', 'Music']) {
		const link = view.getByRole('link', { name: name + ' @source.example' });
		expect(article.contains(link)).toBe(true);
		expect(link.getAttribute('href')).toBe('/gridspace/channels/' + name.toLowerCase() + '?placement=1');
	}
	expect(view.getByText('Native body')).toBeTruthy();
	await fireEvent.click(view.container.querySelector('footer button')!);
	expect(reply).toHaveBeenCalledOnce();
});

test.each([undefined, '/gridspace/channels/channel'])('one article layout preserves content and actions for route %s', async channelTo => {
	const reply = vi.fn(); const context = vi.fn();
	const view = render(NoteArticle, { props: { user, channel, channelTo }, attrs: { onContextmenu: context }, global, slots: {
		header: '<header>Author header</header>', default: '<p>Body text</p>', reactions: '<div>Reactions</div>',
		footer: ({ buttonClass }: { buttonClass: string }) => h('button', { class: buttonClass, onClick: reply }, 'Reply'),
	} });
	const article = view.getByRole('article');
	expect(article.textContent).toContain('Author headerBody text');
	expect(view.getByRole('link', { name: 'Channel name' }).getAttribute('href')).toBe(channelTo ?? '/channels/channel');
	expect(article.querySelector('footer')?.textContent).toBe('Reply');
	expect(view.getByText('user').getAttribute('data-preview')).toBe('true');
	await fireEvent.click(view.getByRole('button', { name: 'Reply' })); expect(reply).toHaveBeenCalledOnce();
	await fireEvent.contextMenu(article); expect(context).toHaveBeenCalledOnce();
	await view.rerender({ showChannelLink: false, avatarPreview: false });
	expect(view.queryByRole('link', { name: 'Channel name' })).toBeNull();
	expect(article.querySelector('[aria-hidden="true"]')).not.toBeNull();
	expect(view.getByText('user').getAttribute('data-preview')).toBe('false');
});
