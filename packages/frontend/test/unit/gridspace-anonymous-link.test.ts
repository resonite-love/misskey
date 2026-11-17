/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, KeepAlive, nextTick, ref } from 'vue';
import Page from '@/pages/gridspace-private.vue';
import Preview from '@/components/MkGridspaceNoteLinkPreview.vue';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/router.js', () => ({ mainRouter: {}, useRouter: () => ({}) }));
vi.mock('@/components/MkInput.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/utility/please-login.js', () => ({ pleaseLogin: vi.fn() }));
vi.mock('@/components/MkGridspaceNoteDetail.vue', () => ({ default: { template: '<div>PRIVATE READER</div>' } }));
vi.mock('@/components/MkGridspacePrivateNotes.vue', () => ({ default: { template: '<div>PRIVATE LIST</div>' } }));
vi.mock('@/components/MkNoteHeader.vue', () => ({ default: { template: '<div>Author</div>' } }));
vi.mock('@/components/MkNoteCw.vue', () => ({ default: { template: '<div>Content warning</div>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { invisibleNote: 'Not visible', retry: 'Retry', login: 'Sign in', details: 'Details', search: 'Search', _gridspace: { privateListMoved: 'Use the ordinary home and search.', openHome: 'Home' } } } }));
const global = { stubs: { PageWithHeader: { template: '<main><slot/></main>' }, MkButton: { template: '<button><slot/></button>' }, MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkLoading: true, MkEllipsis: true, Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } } };

beforeEach(() => {
	api.mockReset();
	Object.defineProperty(document, 'hidden', { configurable: true, value: false });
	vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('the old list entry links to ordinary screens without requesting private notes', async () => {
	const view = render(Page, { global });
	await nextTick();
	expect(view.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
	expect(view.getByRole('link', { name: 'Search' }).getAttribute('href')).toBe('/search');
	expect(view.queryByText('PRIVATE LIST')).toBeNull();
	expect(api).not.toHaveBeenCalled();
});

test('anonymous note links open the verified normal source page automatically', async () => {
	const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
	api.mockResolvedValue({ publicUrl: 'https://r.example/notes/note', localNote: { id: 'note' }, note: null });
	const view = render(Page, { props: { noteId: 'note', channelId: 'channel' }, global });
	await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('https://r.example/notes/note'));
	expect(api).toHaveBeenCalledWith('gridspace/note-link', expect.objectContaining({ url: expect.stringContaining('noteId=note&channelId=channel') }), undefined, expect.anything());
	expect(view.queryByText('PRIVATE READER')).toBeNull();
});

test('a restricted note stays hidden and never redirects', async () => {
	const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
	api.mockRejectedValue(new Error('restricted'));
	const view = render(Page, { props: { noteId: 'note' }, global });
	await vi.waitFor(() => expect(view.getByText('Not visible')).toBeTruthy());
	expect(view.getByText('Sign in')).toBeTruthy();
	expect(replace).not.toHaveBeenCalled();
	expect(view.queryByText('PRIVATE READER')).toBeNull();
});

test('leaving a kept-alive page cancels a delayed anonymous redirect', async () => {
	const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
	let finish: (value: object) => void = () => {};
	api.mockReturnValue(new Promise(resolve => { finish = resolve; }));
	const showing = ref(true);
	const Wrapper = defineComponent({ components: { Page, KeepAlive }, setup: () => ({ showing }), template: '<KeepAlive><Page v-if="showing" noteId="note"/></KeepAlive>' });
	render(Wrapper, { global });
	showing.value = false; await nextTick();
	finish({ publicUrl: 'https://r.example/notes/note' }); await nextTick();
	expect(replace).not.toHaveBeenCalled();
});

test('anonymous link previews use public reads and link to the original page', async () => {
	api.mockResolvedValue({ note: null, publicUrl: 'https://r.example/notes/note', localNote: { id: 'note', text: 'Public body', cw: null, files: [], user: { username: 'author' } } });
	const view = render(Preview, { props: { url: 'https://g.example/gridspace/private?noteId=note' }, global });
	await vi.waitFor(() => expect(view.getByText('Public body')).toBeTruthy());
	expect(view.getByRole('link', { name: /Details/ }).getAttribute('href')).toBe('https://r.example/notes/note');
});

test('a source-only link never renders a hidden remote body', async () => {
	api.mockResolvedValue({ note: null, publicUrl: 'https://r.example/notes/note', localNote: null });
	const view = render(Preview, { props: { url: 'https://g.example/gridspace/private?noteId=note' }, global });
	await vi.waitFor(() => expect(view.getByRole('link', { name: /Details/ }).getAttribute('href')).toBe('https://r.example/notes/note'));
	expect(view.queryByText('Not visible')).toBeNull();
});
