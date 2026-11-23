/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import { nextTick } from 'vue';
import type { entities } from 'misskey-js';
import type { PostFormProps } from '@/types/post-form.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import { url } from '@@/js/config.js';
import MkPostForm from '@/components/MkPostForm.vue';
import { instance } from '@/instance.js';
import { miLocalStorage } from '@/local-storage.js';

const sessionAccount = vi.hoisted(() => ({ id: 'author' }));
const { api, alert, confirm, actions, popupMenu, inputDatetime, handlers } = vi.hoisted(() => ({ api: vi.fn(), alert: vi.fn(), confirm: vi.fn(), actions: vi.fn(async () => ({ canceled: true })), popupMenu: vi.fn(), inputDatetime: vi.fn(), handlers: vi.fn() }));
vi.mock('@/instance.js', async () => {
	const { reactive } = await import('vue');
	return { instance: { features: reactive({ multiNote: true, multiNotePeer: true }), maxNoteTextLength: 3000 } };
});
vi.mock('@/i.js', () => ({ ensureSignin: () => ({ id: sessionAccount.id, policies: { scheduledNoteLimit: 10 }, username: 'author' }), notesCount: 0, incNotesCount: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api, getApiErrorStatus: (error: { httpStatus?: number }) => error.httpStatus }));
vi.mock('@/os.js', () => ({ alert, confirm, actions, popupMenu, inputDatetime }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { defaultNoteVisibility: 'public', defaultNoteLocalOnly: false } } }));
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: { set: vi.fn(), s: { reactionAcceptance: null, visibility: 'public', localOnly: false, noRelay: false }, r: { tips: ref({ postForm: true }) }, model: (key: string) => ref(key === 'postFormHashtags' ? '' : false) } };
});
vi.mock('@/i18n.js', () => ({ i18n: { ts: { schedulePost: 'Schedule', _drafts: {}, _visibility: { public: 'Public', delivery: 'Delivery', deliveryPublic: 'Federate', noRelay: 'Skip relays', disableFederation: 'Local only' }, _multiNote: { pendingCreate: 'Pending', confirmed: 'Confirmed', checkResult: 'Check' }, _channel: {}, _postForm: { _placeholders: {} } } } }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: handlers }));
vi.mock('@/accounts.js', () => ({ getAccounts: async () => [], getAccountMenu: vi.fn() }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { detach() {} } }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/drive.js', () => ({ chooseDriveFile: vi.fn() }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: {} }));
vi.mock('@/utility/mfm-function-picker.js', () => ({ mfmFunctionPicker: vi.fn() }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: vi.fn() }));
vi.mock('@/utility/tour.js', () => ({ startTour: vi.fn() }));
vi.mock('@/events.js', () => ({ globalEvents: { emit: vi.fn() } }));
vi.mock('@/composables/use-uploader.js', async () => {
	const { ref } = await import('vue');
	return { useUploader: () => ({ items: ref([]), uploading: ref(false), events: { on: vi.fn() }, reset: vi.fn(), abortAll: vi.fn(), dispose: vi.fn() }) };
});
vi.mock('@/components/MkUploaderItems.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkNotePreview.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPostFormAttaches.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPostForm.TextCounter.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPollEditor.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkGridspaceNoteLinkPreview.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkNoteSimple.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPostFormActionBar.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkNoteDestinations.vue', () => ({ default: {
	props: ['modelValue'],
	emits: ['update:modelValue'],
	setup() { return { channel: { origin: 'https://peer.example', channelId: 'talk', name: 'Talk', color: '#666' } }; },
	template: `<div>
		<button data-testid="channel-only" @click="$emit('update:modelValue', { includeDefault: false, channels: [channel] })">Choose</button>
		<button data-testid="mixed-destinations" @click="$emit('update:modelValue', { includeDefault: true, channels: [...modelValue.channels, channel] })">Add regular and peer</button>
		<button data-testid="empty-destinations" @click="$emit('update:modelValue', { includeDefault: false, channels: [] })">Clear</button>
		<span data-testid="has-default">{{ modelValue.includeDefault }}</span>
		<span v-if="modelValue.channels.length" data-testid="selected-channel">{{ modelValue.channels[0].name }}</span>
	</div>`,
} }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));

const channel = { origin: 'https://peer.example', channelId: 'talk', name: 'Talk', color: '#666' };

function openComposer(channelPage = true, props: Partial<PostFormProps> = {}) {
	return render(MkPostForm, { props: { initialChannelDestination: channelPage ? channel : undefined, autofocus: false, ...props }, global: { stubs: { MkEllipsis: true, MkAcct: true, MkTime: true, I18n: true, MkTip: true }, directives: { tooltip: {}, clickAnime: {} } } });
}

beforeEach(() => {
	sessionAccount.id = 'author';
	handlers.mockReturnValue([]);
	let active: Promise<unknown> = Promise.resolve();
	Object.defineProperty(navigator, 'locks', { configurable: true, value: {
		request(_key: string, callback: () => unknown) {
			const next = active.then(callback);
			active = next.catch(() => undefined);
			return next;
		},
	} });
});

afterEach(() => { Object.assign(prefer.s, { rememberNoteVisibility: false, defaultNoteLocalOnly: false }); Object.assign(store.s, { localOnly: false, noRelay: false }); cleanup(); Reflect.deleteProperty(navigator, 'locks'); window.localStorage.clear(); vi.clearAllMocks(); instance.features!.multiNotePeer = true; instance.features!.multiNote = true; });
it('sends a fixed placement reference quote with a single destination and a durable receipt', async () => {
	const gridspaceQuote = 'https://peer.example/notes/quoted?gridspaceChannelOrigin=https%3A%2F%2Fpeer.example&gridspaceChannelId=talk';
	api.mockRejectedValueOnce(new TypeError('Response lost'));
	const form = openComposer(false, { fixedQuoteDestination: channel, gridspaceQuote });
	await nextTick();
	await nextTick();
	expect(form.queryByTestId('channel-only')).toBeNull();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Quote');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	const request = api.mock.calls[0][1];
	expect(request).toMatchObject({ gridspaceQuote, includeDefault: false, channelIds: [], channelTargets: [{ origin: channel.origin, channelId: channel.channelId }], localOnly: true, noRelay: false });
	expect(request.clientRequestId).toBeTruthy();
	form.unmount();
	api.mockResolvedValueOnce({ status: 'created', createdNote: { id: 'root', multiNoteKind: 'root', channelPlacementsUnavailable: true } });
	const restored = openComposer(false, { fixedQuoteDestination: channel, gridspaceQuote });
	await waitFor(() => expect(restored.emitted().posted).toHaveLength(1));
	expect(api.mock.calls[1][1]).toEqual({ clientRequestId: request.clientRequestId });
	expect(actions).not.toHaveBeenCalled();
	expect(alert).toHaveBeenLastCalledWith({ type: 'info', text: 'Confirmed' });
});

it('isolates pending fixed quote drafts across signed-in accounts', async () => {
	const gridspaceQuote = 'https://peer.example/notes/quoted?gridspaceChannelOrigin=https%3A%2F%2Fpeer.example&gridspaceChannelId=talk';
	api.mockRejectedValueOnce(new TypeError('Response lost'));
	const form = openComposer(false, { fixedQuoteDestination: channel, gridspaceQuote });
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'First account draft');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	const firstRequest = api.mock.calls[0][1].clientRequestId;
	form.unmount();
	sessionAccount.id = 'second';
	const second = openComposer(false, { fixedQuoteDestination: channel, gridspaceQuote });
	await nextTick();
	await nextTick();
	expect((second.getByTestId('post-form-text') as HTMLTextAreaElement).value).toBe('');
	expect(api).toHaveBeenCalledTimes(1);
	await fireEvent.update(second.getByTestId('post-form-text'), 'Second account draft');
	api.mockResolvedValueOnce({ createdNote: { id: 'second' } });
	await fireEvent.click(second.getByTestId('post-form-submit'));
	await waitFor(() => expect(second.emitted().posted).toHaveLength(1));
	expect(api.mock.calls[1][0]).toBe('notes/create');
	expect(api.mock.calls[1][1].clientRequestId).not.toBe(firstRequest);
	expect(miLocalStorage.getItem('drafts')).toContain(firstRequest);
});

it('edits a published fixed quote with its text and one original placement', async () => {
	const gridspaceQuote = 'https://peer.example/notes/quoted?gridspaceChannelOrigin=https%3A%2F%2Fpeer.example&gridspaceChannelId=talk';
	const note = { gridspaceQuote, text: 'Old comment', includeDefault: false, multiNoteKind: 'root', channelPlacements: [{ ...channel, state: 'active' }], files: [], visibility: 'public', localOnly: true } as unknown as entities.Note;
	const form = openComposer(false, { initialNote: note, fixedQuoteDestination: channel });
	await waitFor(() => expect((form.getByTestId('post-form-text') as HTMLTextAreaElement).value).toBe('Old comment'));
	expect(form.queryByTestId('channel-only')).toBeNull();
	await fireEvent.update(form.getByTestId('post-form-text'), 'New comment');
	api.mockResolvedValueOnce({ createdNote: { id: 'edited' } });
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(form.emitted().posted).toHaveLength(1));
	expect(api.mock.calls[0][1]).toMatchObject({ gridspaceQuote, includeDefault: false, channelIds: [], channelTargets: [{ origin: channel.origin, channelId: channel.channelId }], text: 'New comment' });
});

it.each(['', 'Comment'])('submits a peer reference with or without text in a legacy channel (%j)', async text => {
	const gridspaceQuote = 'https://peer.example/notes/quoted';
	const channel = { id: 'legacy', name: 'Legacy', color: '#999', isSensitive: false, allowRenoteToExternal: true, userId: 'owner' };
	api.mockResolvedValueOnce({ createdNote: { id: 'new' } });
	const form = openComposer(false, { channel, gridspaceQuote });
	await nextTick();
	await nextTick();
	expect(form.queryByTestId('channel-only')).toBeNull();
	expect((form.getByTestId('post-form-delivery') as HTMLButtonElement).disabled).toBe(true);
	if (text) await fireEvent.update(form.getByTestId('post-form-text'), text);
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(form.emitted().posted).toHaveLength(1));
	const [path, payload] = api.mock.calls[0];
	expect(path).toBe('notes/create');
	expect(payload).toMatchObject({ gridspaceQuote, channelId: 'legacy', text: text || null, localOnly: true, noRelay: false });
	expect(payload).not.toHaveProperty('channelIds');
	expect(payload).not.toHaveProperty('clientRequestId');
});

it('keeps the chosen noRelay payload on retry when only delivery changed in the draft', async () => {
	Object.assign(prefer.s, { rememberNoteVisibility: true });
	Object.assign(store.s, { noRelay: true });
	api.mockRejectedValueOnce(new TypeError('Response lost'));
	const form = openComposer(false);
	await nextTick();
	await nextTick();
	await fireEvent.click(form.getByTestId('mixed-destinations'));
	await fireEvent.update(form.getByTestId('post-form-text'), 'Delivery choice');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	const original = api.mock.calls[0][1];
	expect(original).toMatchObject({ localOnly: false, noRelay: true, includeDefault: true });
	await waitFor(() => expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false));
	await fireEvent.click(form.getByTestId('post-form-delivery'));
	const options = popupMenu.mock.calls[0][0];
	expect(options.find((item: { text: string }) => item.text === 'Skip relays').active).toBe(true);
	options.find((item: { text: string }) => item.text === 'Federate').action();
	await nextTick();
	expect(store.set).toHaveBeenCalledWith('noRelay', false);
	confirm.mockResolvedValueOnce({ canceled: false });
	api.mockResolvedValueOnce({ status: 'missing', createdNote: null }).mockResolvedValueOnce({ createdNote: { id: 'original' } });
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
	expect(confirm).toHaveBeenCalledOnce();
	expect(api.mock.calls[2][1]).toEqual(original);
	await waitFor(() => expect(miLocalStorage.getItem('drafts')).not.toContain(original.clientRequestId));
	expect((form.getByTestId('post-form-text') as HTMLTextAreaElement).value).toBe('Delivery choice');
});

it('suppresses a default noRelay choice for channels-only and restores it for mixed destinations', async () => {
	Object.assign(prefer.s, { defaultNoteLocalOnly: 'noRelay' });
	const form = openComposer();
	await nextTick();
	await nextTick();
	const delivery = form.getByTestId('post-form-delivery') as HTMLButtonElement;
	expect(delivery.disabled).toBe(true);
	expect(delivery.getAttribute('aria-label')).toContain('Local only');
	await fireEvent.click(form.getByTestId('mixed-destinations'));
	expect(delivery.disabled).toBe(false);
	expect(delivery.getAttribute('aria-label')).toContain('Skip relays');
	await fireEvent.update(form.getByTestId('post-form-text'), 'Saved locally');
	await waitFor(() => expect(miLocalStorage.getItem('drafts')).toContain('"noRelay":true'));
	form.unmount();
	Object.assign(prefer.s, { defaultNoteLocalOnly: false });
	const restored = openComposer();
	await waitFor(() => expect(restored.getByTestId('post-form-delivery').getAttribute('aria-label')).toContain('Skip relays'));
});

it('recovers the created root from the author receipt on reload while the peer is offline', async () => {
	api.mockRejectedValueOnce(new TypeError('Response lost'));
	const form = openComposer();
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Once');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
	const [path, request] = api.mock.calls[0];
	expect(path).toBe('notes/create');
	expect(request).toMatchObject({ text: 'Once', includeDefault: false, localOnly: true, channelTargets: [{ origin: channel.origin, channelId: channel.channelId }] });
	expect(request.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
	expect(miLocalStorage.getItem('drafts')).toContain(request.clientRequestId);
	form.unmount();

	instance.features!.multiNotePeer = false;
	api.mockResolvedValueOnce({ status: 'created', createdNote: { id: 'original' } });
	const restored = openComposer();
	await waitFor(() => expect(restored.emitted().posted).toHaveLength(1));
	expect(api.mock.calls.map(call => call[0])).toEqual(['notes/create', 'notes/create-status']);
	expect(api.mock.calls[1][1]).toEqual({ clientRequestId: request.clientRequestId });
	expect(miLocalStorage.getItem('drafts')).not.toContain(request.clientRequestId);
});

it('retries the original payload after editing, then preserves the newer draft when the retry response is also lost', async () => {
	api.mockRejectedValueOnce(new TypeError('Response lost'));
	const form = openComposer();
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'First version');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
	const requestId = api.mock.calls[0][1].clientRequestId;
	await waitFor(() => expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false));

	await fireEvent.update(form.getByTestId('post-form-text'), 'New draft after timeout');
	confirm.mockResolvedValueOnce({ canceled: false });
	api.mockResolvedValueOnce({ status: 'missing', createdNote: null }).mockRejectedValueOnce(new TypeError('Timed out'));
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
	expect(api.mock.calls.map(call => call[0])).toEqual(['notes/create', 'notes/create-status', 'notes/create']);
	expect(api.mock.calls[2][1]).toEqual(api.mock.calls[0][1]);
	expect(api.mock.calls[2][1].text).toBe('First version');
	expect(confirm).toHaveBeenCalledTimes(1);
	form.unmount();

	api.mockResolvedValueOnce({ status: 'created', createdNote: { id: 'original' } });
	const restored = openComposer();
	await waitFor(() => expect(alert).toHaveBeenCalledTimes(3));
	expect(api.mock.calls.map(call => call[0])).toEqual(['notes/create', 'notes/create-status', 'notes/create', 'notes/create-status']);
	expect((restored.getByTestId('post-form-text') as HTMLTextAreaElement).value).toBe('New draft after timeout');
	expect(miLocalStorage.getItem('drafts')).not.toContain(requestId);
	expect(restored.emitted().posted).toBeUndefined();
});

it('keeps a newly selected channel-only destination when capabilities change while the ordinary composer is open', async () => {
	const form = openComposer(false);
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Channel only');
	await fireEvent.click(form.getByTestId('channel-only'));
	expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false);
	instance.features!.multiNote = false;
	await nextTick();
	expect(form.getByTestId('selected-channel').textContent).toBe('Talk');
	expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.click(form.getByTestId('post-form-submit'));
	expect(api).not.toHaveBeenCalled();
	const draft = Object.values(JSON.parse(miLocalStorage.getItem('drafts')!) as Record<string, { data: { destinations: unknown } }>)[0];
	expect(draft.data.destinations).toMatchObject({ includeDefault: false, channels: [channel] });
});

it('restores an empty channel-only draft with default publication still off after write capability is disabled', async () => {
	const form = openComposer(false);
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Unfinished selection');
	await fireEvent.click(form.getByTestId('empty-destinations'));
	await waitFor(() => expect(miLocalStorage.getItem('drafts')).toContain('"includeDefault":false,"channels":[]'));
	form.unmount();
	instance.features!.multiNote = false;

	const restored = openComposer(false);
	await waitFor(() => expect(restored.getByTestId('has-default').textContent).toBe('false'));
	expect((restored.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.click(restored.getByTestId('post-form-submit'));
	expect(api).not.toHaveBeenCalled();
});

it('atomically reserves one create ID and preserves another open composer’s newer draft when the first response arrives', async () => {
	let complete!: (value: unknown) => void;
	api.mockImplementation(async (path: string) => path === 'notes/create-status'
		? { status: 'missing', createdNote: null }
		: await new Promise(resolve => { complete = resolve; }));
	const first = openComposer();
	const a = within(first.container as HTMLElement);
	await nextTick();
	await nextTick();
	await fireEvent.update(a.getByTestId('post-form-text'), 'Original');
	await waitFor(() => expect(miLocalStorage.getItem('drafts')).toContain('Original'));
	const second = openComposer();
	const b = within(second.container as HTMLElement);
	await waitFor(() => expect((b.getByTestId('post-form-text') as HTMLTextAreaElement).value).toBe('Original'));
	await Promise.all([fireEvent.click(a.getByTestId('post-form-submit')), fireEvent.click(b.getByTestId('post-form-submit'))]);
	await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
	const creates = api.mock.calls.filter(call => call[0] === 'notes/create');
	expect(creates).toHaveLength(1);
	const controls = [a, b];
	const other = controls.find(view => !(view.getByTestId('post-form-text') as HTMLTextAreaElement).disabled)!;
	await fireEvent.update(other.getByTestId('post-form-text'), 'Updated in another tab');
	await waitFor(() => expect(miLocalStorage.getItem('drafts')).toContain('Updated in another tab'));
	complete({ createdNote: { id: 'original' } });
	await waitFor(() => expect(first.emitted().posted || second.emitted().posted).toHaveLength(1));
	await nextTick();
	const draft = Object.values(JSON.parse(miLocalStorage.getItem('drafts')!) as Record<string, { data: { text: string; pendingCreate: unknown } }>)[0];
	expect(draft.data.text).toBe('Updated in another tab');
	expect(draft.data.pendingCreate).toBeNull();
});

it('releases an unequivocally rejected first request only after the author receipt confirms it is missing', async () => {
	const refusal = { id: 'invalid', code: 'INVALID_NOTE_PLACEMENT', kind: 'client', httpStatus: 400, message: 'Channel unavailable' };
	api.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ status: 'missing', createdNote: null });
	const form = openComposer();
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Rejected');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	const firstId = api.mock.calls[0][1].clientRequestId;
	expect(api.mock.calls.map(call => call[0])).toEqual(['notes/create', 'notes/create-status']);
	expect(miLocalStorage.getItem('drafts')).not.toContain('"clientRequestId"');
	expect(miLocalStorage.getItem('drafts')).toContain('Rejected');

	await waitFor(() => expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false));
	await fireEvent.update(form.getByTestId('post-form-text'), 'Corrected');
	api.mockResolvedValueOnce({ createdNote: { id: 'created' } });
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(form.emitted().posted).toHaveLength(1));
	expect(api.mock.calls[2][1]).toMatchObject({ text: 'Corrected' });
	expect(api.mock.calls[2][1].clientRequestId).not.toBe(firstId);
});

it('keeps an uncertain original request when a later retry gets a 4xx', async () => {
	api.mockRejectedValueOnce(new TypeError('Lost response'));
	const form = openComposer();
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Original');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	const originalRequest = api.mock.calls[0][1];
	await waitFor(() => expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(false));
	api.mockResolvedValueOnce({ status: 'missing', createdNote: null }).mockRejectedValueOnce({ kind: 'client', httpStatus: 403, message: 'Revoked' });
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
	expect(api.mock.calls[2][1]).toEqual(originalRequest);
	expect(miLocalStorage.getItem('drafts')).toContain(originalRequest.clientRequestId);
});

it('cannot switch an explicitly empty destination into a quote or a scheduled ordinary post', async () => {
	const form = openComposer(false);
	await nextTick();
	await nextTick();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Unfinished');
	const settings = form.container.querySelector('button:has(.ti-dots)')!;
	await fireEvent.click(settings);
	const schedule = popupMenu.mock.calls[0][0].find((item: { icon?: string }) => item.icon === 'ti ti-calendar-time');
	expect(schedule).toBeTruthy();
	await fireEvent.click(form.getByTestId('empty-destinations'));
	await schedule.action();
	expect(inputDatetime).not.toHaveBeenCalled();
	await fireEvent.click(settings);
	expect(popupMenu.mock.calls[1][0].some((item: { icon?: string }) => item.icon === 'ti ti-calendar-time')).toBe(false);
	await fireEvent.paste(form.getByTestId('post-form-text'), { clipboardData: { items: [], getData: () => url + '/notes/quoted' } });
	expect(confirm).not.toHaveBeenCalled();
	expect((form.getByTestId('post-form-submit') as HTMLButtonElement).disabled).toBe(true);
	expect(api).not.toHaveBeenCalled();
});

it('preserves an edit arriving while an original payload retry is in flight', async () => {
	api.mockRejectedValueOnce(new TypeError('Lost response'));
	const form = openComposer();
	await nextTick();
	await nextTick();
	const field = form.getByTestId('post-form-text') as HTMLTextAreaElement;
	await fireEvent.update(field, 'Original');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	await waitFor(() => expect(field.disabled).toBe(false));
	let finish!: (value: unknown) => void;
	api.mockResolvedValueOnce({ status: 'missing', createdNote: null }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
	expect(field.disabled).toBe(true);
	await fireEvent.update(field, 'Edited by another input source');
	finish({ createdNote: { id: 'original' } });
	await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
	expect(field.value).toBe('Edited by another input source');
	expect(form.emitted().posted).toBeUndefined();
	expect(miLocalStorage.getItem('drafts')).toContain('Edited by another input source');
});

it('does not reserve a newer draft with a payload captured before an asynchronous plugin completed', async () => {
	let finish!: () => void;
	handlers.mockImplementation((name: string) => name === 'note_post_interruptor' ? [{
		handler: async (input: unknown) => { await new Promise<void>(resolve => { finish = resolve; }); return input; },
	}] : []);
	const form = openComposer();
	await nextTick();
	await nextTick();
	const field = form.getByTestId('post-form-text') as HTMLTextAreaElement;
	await fireEvent.update(field, 'Before plugin');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(finish).toBeDefined());
	expect(field.disabled).toBe(true);
	await fireEvent.update(field, 'During plugin');
	finish();
	await waitFor(() => expect(field.disabled).toBe(false));
	expect(api).not.toHaveBeenCalled();
	expect(miLocalStorage.getItem('drafts')).toContain('During plugin');
});

it.each([false, true])('submits one sensitive channel note with optional shared CW when mixed=%s', async mixed => {
	const localChannel = { id: 'sensitive', name: 'Sensitive', color: '#999', isSensitive: true, allowRenoteToExternal: true, userId: 'owner' };
	api.mockResolvedValueOnce({ createdNote: { id: 'new', multiNoteKind: 'root', channelPlacementsUnavailable: true } });
	const form = openComposer(false, { channel: localChannel, initialCw: mixed ? 'Author warning' : undefined });
	await nextTick();
	await nextTick();
	expect(form.getByTestId('selected-channel').textContent).toBe('Sensitive');
	expect(form.getByTestId('has-default').textContent).toBe('false');
	if (mixed) await fireEvent.click(form.getByTestId('mixed-destinations'));
	await fireEvent.update(form.getByTestId('post-form-text'), 'Original content');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(form.emitted().posted).toHaveLength(1));
	expect(api).toHaveBeenCalledTimes(1);
	expect(actions).not.toHaveBeenCalled();
	expect(alert).not.toHaveBeenCalled();
	const [path, request] = api.mock.calls[0];
	expect(path).toBe('notes/create');
	expect(request).toMatchObject({
		text: 'Original content', cw: mixed ? 'Author warning' : null, includeDefault: mixed, localOnly: !mixed,
		channelIds: ['sensitive'], channelTargets: mixed ? [{ origin: channel.origin, channelId: channel.channelId }] : [],
	});
	expect(request.channelId).toBeUndefined();
});

it.each(['reply', 'renote'] as const)('preserves the legacy local channel for a fixed %s target', async kind => {
	const target = { id: 'parent', text: 'Parent', visibility: 'public', userId: 'author', user: { id: 'author', username: 'author', host: null } } as entities.Note;
	const localChannel = { id: 'legacy', name: 'Local', color: '#999', isSensitive: true, allowRenoteToExternal: false, userId: 'owner' };
	api.mockResolvedValueOnce({ createdNote: { id: 'new' } });
	const form = openComposer(false, { [kind]: target, channel: localChannel });
	await nextTick();
	await nextTick();
	expect(form.queryByTestId('channel-only')).toBeNull();
	await fireEvent.update(form.getByTestId('post-form-text'), 'Comment');
	await fireEvent.click(form.getByTestId('post-form-submit'));
	await waitFor(() => expect(form.emitted().posted).toHaveLength(1));
	const [path, request] = api.mock.calls[0];
	expect(path).toBe('notes/create');
	expect(request).toMatchObject({ channelId: 'legacy', [kind === 'reply' ? 'replyId' : 'renoteId']: 'parent' });
	expect(request).not.toHaveProperty('clientRequestId');
});
