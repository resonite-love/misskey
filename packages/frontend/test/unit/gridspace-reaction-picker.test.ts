/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, ref } from 'vue';
import type { entities } from 'misskey-js';
import NoteActions from '@/components/MkGridspaceNoteActions.vue';

const { api, show } = vi.hoisted(() => ({ api: vi.fn(), show: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show } }));
vi.mock('@/os.js', () => ({ confirm: vi.fn().mockResolvedValue({ canceled: false }) }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkPoll.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkReactionsViewer.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: { template: '<div/>' } }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const note = { id: 'source-note', uri: 'https://source.example/notes/source-note', origin: 'https://source.example', channelId: 'source-channel', extendedReactions: true, reactions: {}, myReactions: [] } as unknown as entities.GridspacePrivateNotesResponse['notes'][number];
const result = { note, canInteract: true, account: { uri: 'https://source.example/users/self' } };

async function openPicker(target = note) {
	const view = render(defineComponent({
		setup() {
			const actions = ref<InstanceType<typeof NoteActions>>();
			return () => h('div', [
				h(NoteActions, { ref: actions, note: target, compact: true }),
				h('button', { onClick: (event: MouseEvent) => actions.value?.react(event) }, 'React'),
			]);
		},
	}));
	await fireEvent.click(view.getByRole('button', { name: 'React' }));
	await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
	return { view, choose: show.mock.calls[0][2] as (reaction: string) => void };
}

test('sends rapid linked reactions in order and checks permissions for each', async () => {
	let finishFirst!: (value: typeof result) => void;
	api.mockImplementation((_endpoint, request) => request.action === 'add-reaction' && request.reaction === '👍'
		? new Promise(resolve => { finishFirst = resolve; })
		: Promise.resolve(result));
	const { choose } = await openPicker();
	choose('👍'); choose('🎉');
	await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
	expect(api.mock.calls.filter(([, request]) => request.action === 'add-reaction')).toHaveLength(1);
	finishFirst(result);
	await vi.waitFor(() => expect(api.mock.calls.filter(([, request]) => request.action === 'add-reaction')).toHaveLength(2));
	expect(api.mock.calls.map(([, request]) => request.action)).toEqual(['prepare', 'prepare', 'add-reaction', 'prepare', 'add-reaction']);
	expect(api.mock.calls.filter(([, request]) => request.action === 'add-reaction').map(([, request]) => [request.reaction, request.expectedActorUri])).toEqual([
		['👍', result.account.uri], ['🎉', result.account.uri],
	]);
});

test('a picker choice keeps the actor-home key when the note already has a same-name source emoji', async () => {
	const target = { ...note, reactions: { ':cat@.:': 1 } };
	api.mockResolvedValue({ ...result, note: target });
	const { choose } = await openPicker(target);
	choose(':cat:');
	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('gridspace/private-action',
		expect.objectContaining({ action: 'add-reaction', reaction: ':cat:' }), undefined, expect.any(AbortSignal)));
});

test('does not send queued reactions after leaving the note', async () => {
	let finishFirst!: (value: typeof result) => void;
	api.mockImplementation((_endpoint, request) => request.action === 'add-reaction'
		? new Promise(resolve => { finishFirst = resolve; })
		: Promise.resolve(result));
	const { view, choose } = await openPicker();
	choose('👍'); choose('🎉');
	await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
	view.unmount();
	finishFirst(result);
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(api.mock.calls.filter(([, request]) => request.action === 'add-reaction')).toHaveLength(1);
});
