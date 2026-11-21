/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import Preview from '@/components/MkGridspaceNoteLinkPreview.vue';
let visibilityCallback: (entries: { isIntersecting: boolean }[]) => void;
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { invisibleNote: 'Not visible', details: 'Details' }, tsx: { withNFiles: ({ n }: { n: number }) => `${n} files` } } }));
vi.mock('@/components/MkNoteHeader.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkNoteCw.vue', () => ({ default: { template: '<div>Content warning</div>' } }));
vi.mock('@/components/MkGridspacePrivateNote.vue', () => ({ default: { props: ['note', 'quotePreview'], template: '<div data-quote-preview>{{ note.text }}</div>' } }));
vi.mock('@/components/MkNoteSimple.vue', () => ({ default: { props: ['note'], template: '<div data-quote-preview>{{ note.text }}</div>' } }));
const note = { id: 'note', text: 'Protected text', cw: null, files: [], author: { username: 'author', uri: 'https://r.example/users/author' }, visibility: 'public' };
const globals = { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, Mfm: { props: ['text'], template: '<span>{{ text }}</span>' }, MkEllipsis: true } };
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof visibilityCallback) { visibilityCallback = callback; } observe() {} disconnect() {} }); api.mockReset(); api.mockResolvedValue({ note, localNote: null }); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
test('previews through the authenticated endpoint and clears content on hide and permission loss', async () => {
	const view = render(Preview, { props: { url: 'https://g.example/gridspace/private?noteId=note' }, global: globals });
	await vi.waitFor(() => expect(view.getByText('Protected text')).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/note-link', { url: 'https://g.example/gridspace/private?noteId=note' }, undefined, expect.anything());
	Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(view.queryByText('Protected text')).toBeNull());
	api.mockRejectedValue(new Error('revoked')); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(view.getByText('Not visible')).toBeTruthy());
});
test('does not display the body of a CW note before expansion', async () => {
	api.mockResolvedValue({ note: { ...note, cw: 'Warning' }, localNote: null });
	const view = render(Preview, { props: { url: 'https://g.example/gridspace/private?noteId=note' }, global: globals });
	await vi.waitFor(() => expect(view.getByText('Content warning')).toBeTruthy());
	expect(view.queryByText('Protected text')).toBeNull();
});

test('removes an offscreen preview and waits for renewed permission before revealing it', async () => {
	const view = render(Preview, { props: { url: 'https://g.example/gridspace/private?noteId=note' }, global: globals });
	await vi.waitFor(() => expect(view.getByText('Protected text')).toBeTruthy());
	visibilityCallback([{ isIntersecting: false }]);
	await vi.waitFor(() => expect(view.queryByText('Protected text')).toBeNull());
	api.mockRejectedValue(new Error('revoked'));
	visibilityCallback([{ isIntersecting: true }]);
	await vi.waitFor(() => expect(view.getByText('Not visible')).toBeTruthy());
	expect(view.queryByText('Protected text')).toBeNull();
});

test('requires the same active qualified placement to compose a restricted quote while preserving a readable published reference', async () => {
	const route = { origin: 'https://r.example', channelId: 'same', canonicalUri: 'https://g.example/notes/root', state: 'active', isArchived: false, allowRenoteToExternal: false };
	api.mockResolvedValue({ note: { ...note, canQuoteOutside: false, channelPlacements: [route] }, localNote: null });
	const source = 'https://g.example/notes/root?gridspaceChannelOrigin=https%3A%2F%2Fr.example&gridspaceChannelId=same';
	const view = render(Preview, { props: { url: source, quote: true, composing: true, quoteDestination: { ...route, origin: 'https://g.example' } }, global: globals });
	await vi.waitFor(() => expect(view.getByText('Not visible')).toBeTruthy());
	await view.rerender({ quoteDestination: route });
	await vi.waitFor(() => expect(view.container.querySelector('[data-quote-preview]')?.textContent).toBe('Protected text'));
	api.mockResolvedValue({ note: { ...note, canQuoteOutside: false, channelPlacements: [] }, localNote: null });
	await view.rerender({ composing: false, quoteDestination: null });
	await vi.waitFor(() => expect(view.container.querySelector('[data-quote-preview]')?.textContent).toBe('Protected text'));
	api.mockResolvedValue({ note: null, localNote: null });
	await vi.advanceTimersByTimeAsync(30000);
	expect(view.getByText('Not visible')).toBeTruthy();
});

test('outside quotes render a compact card and remove only its source on permission loss', async () => {
	api.mockResolvedValue({ note: { ...note, canQuoteOutside: true }, localNote: null });
	const view = render(Preview, { props: { url: 'https://g.example/gridspace/private?noteId=note&channelId=channel', quote: true }, global: globals });
	await vi.waitFor(() => expect(view.container.querySelector('[data-quote-preview]')?.textContent).toBe('Protected text'));
	api.mockResolvedValue({ note: { ...note, canQuoteOutside: false }, localNote: null });
	await vi.advanceTimersByTimeAsync(30000);
	expect(view.queryByText('Protected text')).toBeNull();
	expect(view.getByText('Not visible')).toBeTruthy();
});
