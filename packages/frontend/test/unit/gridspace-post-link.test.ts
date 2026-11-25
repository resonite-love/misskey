/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref } from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import Form from '@/components/MkGridspacePostForm.vue';
const { api, confirm } = vi.hoisted(() => ({ api: vi.fn(), confirm: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ confirm, popupMenu: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'current' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { quoteQuestion: 'Quote?', text: 'Text', note: 'Post', quote: 'Quote', retry: 'Retry', channel: 'Channel', annotation: 'CW', _gridspace: {}, _postForm: {} } } }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { detach() {} } }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: {} }));
vi.mock('@/utility/mfm-function-picker.js', () => ({ mfmFunctionPicker: vi.fn() }));
vi.mock('@/composables/use-uploader.js', () => ({ getUploadName: (item: { name: string }) => item.name, useUploader: () => {
	const items = ref<{ id: string; name: string; file: File; isSensitive?: boolean; caption?: string }[]>([]);
	return { items, reset() { items.value = []; }, addFiles(files: File[]) { items.value.push(...files.map(file => ({ id: file.name, name: file.name, file }))); } };
} }));
vi.mock('@/components/MkPostFormHeader.vue', () => ({ default: { template: '<div><slot/><slot name="account"/></div>' } }));
vi.mock('@/components/MkPostFormFields.vue', () => ({ default: { template: '<div><slot/><slot name="cw"/><slot name="counter"/></div>' } }));
vi.mock('@/components/MkPostFormActionBar.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkUploaderItems.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPollEditor.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
const note = { id: 'original', channelId: 'channel', text: 'Original', cw: null, author: { username: 'author', uri: 'https://r.example/users/a' }, visibility: 'public', files: [] } as unknown as entities.GridspacePrivateNotesResponse['notes'][number];
const prepared = { account: { username: 'current', host: 'g.example', uri: 'https://g.example/users/current' }, canReply: true, canAttach: true, maxTextLength: 3000, recipients: [] };
const global = { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' }, MkLoading: true, MkEllipsis: true, MkA: true } };
beforeEach(() => { confirm.mockResolvedValue({ canceled: false }); api.mockReset(); api.mockImplementation(async path => path === 'gridspace/search-info' ? { enabled: true, origins: ['https://g.example', 'https://r.example'] } : path === 'gridspace/private-notes' ? { notes: [note] } : path === 'gridspace/note-link' ? { note, localNote: null } : { ...prepared, createdNoteId: 'created' }); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('pasting into the same channel attaches the quote and keeps the existing draft', async () => {
	const view = render(Form, { props: { channelId: 'channel', initialText: 'My comment' }, global });
	const textarea = await view.findByRole('textbox', { name: 'Text' });
	await vi.waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('My comment'));
	await fireEvent.paste(textarea, { clipboardData: { files: [], getData: () => 'https://g.example/gridspace/private?noteId=original&channelId=channel' } });
	await vi.waitFor(() => expect(view.getByText('Original')).toBeTruthy());
	expect((textarea as HTMLTextAreaElement).value).toBe('My comment');
	expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'prepare', renoteId: 'original', channelId: 'channel' }), undefined, expect.anything());
});

test('an explicit cross-channel quote sends the original channel separately from its destination', async () => {
	const view = render(Form, { props: { channelId: 'destination', renote: note, initialText: 'Comment' }, global });
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'prepare', channelId: 'destination', sourceChannelId: 'channel', renoteId: 'original' }), undefined, expect.anything()));
	await vi.waitFor(() => expect((view.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false));
	await fireEvent.click(view.getByTestId('post-form-submit'));
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'send', channelId: 'destination', sourceChannelId: 'channel', renoteId: 'original', text: 'Comment' }), undefined, expect.anything()));
});

test.each(['channel', 'destination'])('uploads attachments within the destination authorization scope (%s)', async destination => {
	const upload = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ id: 'uploaded' }) }));
	vi.stubGlobal('fetch', upload);
	const view = render(Form, { props: { channelId: destination, renote: note, initialText: 'Comment', initialFiles: [{ file: new File(['test'], 'test.png') }] }, global });
	await vi.waitFor(() => expect((view.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false));
	await fireEvent.click(view.getByTestId('post-form-submit'));
	await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
	const form = upload.mock.calls[0][1].body as FormData;
	expect(form.get('channelId')).toBe(destination);
	expect(form.get('noteId')).toBe(destination === 'channel' ? 'original' : null);
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'send', fileIds: ['uploaded'] }), undefined, expect.anything()));
});
test('cancelled quote leaves the pasted URL in the draft', async () => {
	confirm.mockResolvedValue({ canceled: true });
	const view = render(Form, { props: { channelId: 'channel' }, global });
	const textarea = await view.findByRole('textbox', { name: 'Text' });
	const url = 'https://g.example/gridspace/private?noteId=original&channelId=channel';
	await fireEvent.paste(textarea, { clipboardData: { files: [], getData: () => url } });
	await vi.waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(url));
	expect(view.queryByText('Original')).toBeNull();
});

test('a pasted quote keeps its target after changing tabs', async () => {
	const view = render(Form, { props: { channelId: 'channel', initialText: 'My comment' }, global });
	const textarea = await view.findByRole('textbox', { name: 'Text' });
	await vi.waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('My comment'));
	await fireEvent.paste(textarea, { clipboardData: { files: [], getData: () => 'https://g.example/gridspace/private?noteId=original&channelId=channel' } });
	await vi.waitFor(() => expect(view.getByText('Original')).toBeTruthy());
	Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(view.queryByText('Original')).toBeNull());
	Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(view.getByText('Original')).toBeTruthy());
	await fireEvent.click(view.getByTestId('post-form-submit'));
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'send', renoteId: 'original', channelId: 'channel', text: 'My comment' }), undefined, expect.anything()));
});

test('rejected initial attachments cannot turn into a text-only send after reauthorization', async () => {
	const file = new File(['image'], 'image.png');
	api.mockResolvedValue({ ...prepared, canAttach: false });
	const view = render(Form, { props: { channelId: 'channel', initialText: 'Keep this with its file', initialFiles: [{ file }] }, global });
	await vi.waitFor(() => expect(view.queryByTestId('post-form-text')).toBeNull());
	Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
	Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
	await Promise.resolve();
	expect((view.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(true);
});

test('explicit retry recovers an initial prepare failure', async () => {
	api.mockRejectedValueOnce(new Error('offline'));
	const view = render(Form, { props: { channelId: 'channel', initialText: 'My comment' }, global });
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy());
	await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
	await vi.waitFor(() => expect((view.getByRole('textbox', { name: 'Text' }) as HTMLTextAreaElement).value).toBe('My comment'));
});
