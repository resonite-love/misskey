/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, ref } from 'vue';
import type { entities } from 'misskey-js';
import { useNote } from '@/composables/use-note.js';
import NotePlacements from '@/components/MkNotePlacements.vue';

const { api, popupMenu, confirm } = vi.hoisted(() => ({ api: vi.fn(async (path: string) => path === 'i/registry/keys' ? [] : {}), popupMenu: vi.fn(async (_items: unknown) => {}), confirm: vi.fn(async () => ({ canceled: false })) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ popupMenu, confirm, apiWithDialog: api }));
vi.mock('@/i.js', () => ({ iAmModerator: false, $i: { id: 'author', username: 'author', policies: {}, mutedWords: [], hardMutedWords: [] } }));
vi.mock('@/router.js', () => ({ mainRouter: { currentRoute: { value: {} } }, useRouter: vi.fn() }));
vi.mock('@/events.js', () => ({ useGlobalEvent: vi.fn(), globalEvents: { emit: vi.fn() } }));
vi.mock('@/composables/use-note-capture.js', () => ({ useNoteCapture: () => ({ $note: {}, subscribe: vi.fn() }) }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn() }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/utility/check-word-mute.js', () => ({ checkWordMute: () => false }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _multiNote: { placements: 'Placements', failed: 'Failed', retryPlacement: 'Retry', removed: 'Removed' } }, tsx: { _multiNote: { removePlacement: () => 'Remove', confirmRemove: () => 'Confirm' } } } }));
afterEach(cleanup);

test.each([['active', 'removed'], ['failed', 'active']])('refreshes native placement chips and the renote action when a placement changes from %s to %s', async (before, after) => {
	const route = { canonicalUri: 'https://site.test/notes/note', origin: 'https://site.test', channelId: 'channel', name: 'Talk', color: '#888', state: before, isArchived: false, canRemove: before === 'active', canRetry: before === 'failed' };
	const note = { id: 'note', uri: route.canonicalUri, multiNoteKind: 'root', includeDefault: false, channelPlacements: [route], text: 'Hello', files: [], userId: 'author', user: { id: 'author', host: null }, visibility: 'public' } as unknown as entities.Note;
	api.mockImplementation(async path => path === 'notes/show' ? { ...note, channelPlacements: [{ ...route, state: after, canRemove: false }] } : {});
	const card = defineComponent({
		setup() {
			const menuButton = ref<HTMLElement | null>(null);
			const { appearNote, canRenote, showMenu } = useNote({ note }, { menuButton });
			return () => h('div', [
				h(NotePlacements, { placements: appearNote.channelPlacements, includeDefault: false }),
				h('button', { ref: menuButton, onClick: showMenu }, 'Menu'),
				canRenote.value ? h('button', 'Renote') : null,
			]);
		},
	});
	const view = render(card, { global: { stubs: { MkA: { template: '<a><slot/></a>' } } } });
	expect(!!view.queryByText('Renote')).toBe(before === 'active');
	await fireEvent.click(view.getByText('Menu'));
	const items = popupMenu.mock.lastCall![0] as { text?: string; children?: { action: () => Promise<void> }[] }[];
	await items.find(item => item.text === 'Placements')!.children![0].action();
	await waitFor(() => expect(!!view.queryByText('Renote')).toBe(after === 'active'));
	expect(view.getByText(after === 'active' ? /^Talk/ : /Talk.*Removed/)).toBeTruthy();
});
