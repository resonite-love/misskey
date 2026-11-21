/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import PostForm from '@/components/MkGridspacePostForm.vue';

const { api, confirm } = vi.hoisted(() => ({ api: vi.fn(), confirm: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ confirm }));
vi.mock('@/instance.js', () => ({ instance: { features: { multiNote: true, multiNotePeer: true } } }));
vi.mock('@/components/MkPostForm.vue', () => ({ __esModule: true, default: {
	props: ['initialChannelDestination', 'initialCw'],
	template: '<div data-testid="native-destination">{{ JSON.stringify(initialChannelDestination) }}</div>',
} }));
vi.mock('@/i.js', () => ({ $i: { id: 'current', token: 'token' } }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { detach() {} } }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { show: vi.fn() } }));
vi.mock('@/utility/mfm-function-picker.js', () => ({ mfmFunctionPicker: vi.fn() }));
vi.mock('@/composables/use-uploader.js', async () => {
	const { ref } = await import('vue');
	return { useUploader: () => ({ items: ref([]), reset: vi.fn() }), getUploadName: vi.fn() };
});
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/components/MkPollEditor.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkUploaderItems.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { text: 'Text', note: 'Post', quote: 'Quote', reply: 'Reply', close: 'Close', annotation: 'CW', retry: 'Retry', _postForm: {}, _gridspace: {}, _visibility: { public: 'Public', followers: 'Followers', specified: 'Direct' } } } }));

beforeEach(() => { vi.clearAllMocks(); window.sessionStorage.clear(); });
afterEach(cleanup);
const target = { id: 'source-note', text: 'Original channel post', author: { name: 'Source author', username: 'source' }, files: [], channelId: 'source-channel' } as unknown as entities.GridspacePrivateNotesResponse['notes'][number];
const prepared = { canReply: true, canAttach: true, account: { username: 'current', host: 'g.example', uri: 'https://g.example/users/current' }, recipients: [], maxTextLength: 3000 };

test('opens the placement composer on a sensitive public peer channel', async () => {
	const channel = { name: 'Peer channel', color: '#123', isSensitive: true, allowRenoteToExternal: true };
	const channelOrigin = 'https://peer.example';
	const view = render(PostForm, { props: { channelId: 'source-channel', channelOrigin, channel }, global: { stubs: { MkEllipsis: true, MkLoading: true, Mfm: true, MkA: true } } });
	const destination = await view.findByTestId('native-destination');
	expect(JSON.parse(destination.textContent!)).toEqual({ ...channel, channelId: 'source-channel', origin: channelOrigin });
	expect(api).not.toHaveBeenCalled();
});

test('channel quote displays its target and sends a renote instead of a reply', async () => {
	api.mockImplementation(async (_path, input) => input.action === 'prepare' ? prepared : { ...prepared, createdNoteId: 'created' });
	const view = render(PostForm, { props: { channelId: 'source-channel', renote: target }, global: { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' }, MkLoading: true, MkA: true } } });
	await vi.waitFor(() => expect(view.getByText('Original channel post')).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'prepare', renoteId: 'source-note', channelId: 'source-channel' }), undefined, expect.anything());
	await fireEvent.update(view.getByRole('textbox', { name: 'Text' }), 'My comment');
	await fireEvent.click(view.getByRole('button', { name: 'Quote' }));
	await vi.waitFor(() => expect(view.emitted().sent).toHaveLength(1));
	expect(api).toHaveBeenLastCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'send', channelId: 'source-channel', renoteId: 'source-note', noteId: undefined, text: 'My comment', expectedActorUri: prepared.account.uri }), undefined, expect.anything());
});

test('ordinary replies keep using the reply target', async () => {
	api.mockResolvedValue(prepared);
	const view = render(PostForm, { props: { channelId: 'source-channel', reply: target }, global: { stubs: { Mfm: true, MkLoading: true, MkA: true } } });
	await vi.waitFor(() => expect(view.getByRole('button', { name: 'Reply' })).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/channel-post', expect.objectContaining({ noteId: 'source-note', renoteId: undefined }), undefined, expect.anything());
});

test.each([
	['public', 'Public', 'ti-world'],
	['followers', 'Followers', 'ti-lock'],
	['specified', 'Direct', 'ti-mail'],
] as const)('displays the prepared %s reply audience and its icon', async (visibility, label, icon) => {
	api.mockResolvedValue({ ...prepared, visibility });
	const reply = visibility === 'public'
		? { ...target, multiNoteKind: 'root' as const, includeDefault: false, uri: 'https://g.example/notes/source-note' }
		: target;
	const view = render(PostForm, { props: { reply }, global: { stubs: { Mfm: true, MkLoading: true, MkA: true } } });
	expect(view.queryByTitle('Followers')).toBeNull();
	const audience = await view.findByTitle(label);
	expect(audience.textContent).toBe(label);
	expect(audience.querySelector('i')?.classList.contains(icon)).toBe(true);
});
