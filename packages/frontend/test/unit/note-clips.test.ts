/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import NoteClips from '@/components/MkNoteClips.vue';
import NoteDetail from '@/components/MkGridspaceNoteDetail.vue';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
const snapshot = vi.hoisted(() => ({ note: {} as Record<string, unknown> }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/components/MkClipPreview.vue', () => ({ default: { props: ['clip', 'peerOrigin'], template: '<a :href="`/clips/${clip.id}${peerOrigin ? \'/linked\' : \'\'}`">{{ clip.name }}</a>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { clip: 'Clips', retry: 'Retry', _gridspace: { collectionsPartial: 'Some clips are unavailable' } } } }));
vi.mock('@/components/MkGridspacePrivateNotes.vue', async () => {
	const { defineComponent, onMounted } = await import('vue');
	return { default: defineComponent({ emits: ['snapshot'], setup(_, { emit }) { onMounted(() => emit('snapshot', snapshot.note)); return () => null; } }) };
});

beforeEach(() => { vi.clearAllMocks(); api.mockResolvedValue({ clips: [], partial: false }); });
afterEach(cleanup);

test('loads clips without a local clippedCount and preserves equal IDs from separate servers', async () => {
	api.mockResolvedValue({ clips: [{ id: 'same', name: 'Local' }, { id: 'same', name: 'Resonite', gridspaceOrigin: 'https://r.example' }], partial: false });
	const view = render(NoteClips, { props: { noteId: 'note' } });
	await vi.waitFor(() => expect(view.getByText('Resonite')).toBeTruthy());
	expect(api).toHaveBeenCalledWith('gridspace/note-clips', { noteId: 'note', source: 'local', channelId: undefined }, undefined, expect.anything());
	expect(view.getByText('Local').getAttribute('href')).toBe('/clips/same');
	expect(view.getByText('Resonite').getAttribute('href')).toBe('/clips/same/linked');
});

test('keeps available clips visible during a partial failure and allows retry', async () => {
	api.mockResolvedValueOnce({ clips: [{ id: 'local', name: 'Local' }], partial: true }).mockResolvedValueOnce({ clips: [{ id: 'remote', name: 'Recovered' }], partial: false });
	const view = render(NoteClips, { props: { noteId: 'note' } });
	await vi.waitFor(() => expect(view.getByText('Local')).toBeTruthy());
	await fireEvent.click(view.getByText('Retry'));
	await vi.waitFor(() => expect(view.getByText('Recovered')).toBeTruthy());
	expect(view.queryByText('Some clips are unavailable')).toBeNull();
});

test('discards a stale response after moving to another note', async () => {
	let finish!: (value: unknown) => void;
	api.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
	const view = render(NoteClips, { props: { noteId: 'old' } });
	await view.rerender({ noteId: 'new' });
	finish({ clips: [{ id: 'old', name: 'Stale' }], partial: false });
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(view.queryByText('Stale')).toBeNull();
});

test('uses the delegated source and channel context for linked notes', async () => {
	render(NoteClips, { props: { noteId: 'remote', source: 'peer', channelId: 'channel' } });
	expect(api).toHaveBeenCalledWith('gridspace/note-clips', { noteId: 'remote', source: 'peer', channelId: 'channel' }, undefined, expect.anything());
});

test('looks up dedicated guest clips by conversation and refreshes when that context changes', async () => {
	const first = 'https://peer.test/notes/remote';
	snapshot.note = { id: 'remote', channelId: 'channel', files: [] };
	const view = render(NoteDetail, { props: { noteId: 'remote', channelId: 'channel', conversationUri: first } });
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/note-clips', { source: 'peer', noteId: 'remote', conversationUri: first }, undefined, expect.anything()));
	view.unmount();

	const clips = render(NoteClips, { props: { source: 'peer', noteId: 'remote', conversationUri: first } });
	await clips.rerender({ conversationUri: 'https://other.test/notes/remote' });
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('gridspace/note-clips', { source: 'peer', noteId: 'remote', conversationUri: 'https://other.test/notes/remote' }, undefined, expect.anything()));
});

test.each([true, false])('peer details resolve the same displayed note for pure renotes: %s', async pure => {
	const original = { id: 'original', channelId: 'channel', text: 'Content', files: [] };
	snapshot.note = { id: 'wrapper', channelId: 'channel', renoteId: 'original', renote: original, text: pure ? null : 'Quote', cw: null, replyId: null, files: [], poll: null };
	render(NoteDetail, { props: { noteId: 'wrapper', channelId: 'channel' } });
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/note-clips', { noteId: pure ? 'original' : 'wrapper', source: 'peer', channelId: 'channel' }, undefined, expect.anything()));
});
