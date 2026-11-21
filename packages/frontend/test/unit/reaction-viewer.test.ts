/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { shallowRef } from 'vue';
import Viewer from '@/components/MkReactionsViewer.vue';

const mocks = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), fetch: vi.fn(), menu: vi.fn(), confirm: vi.fn() }));
vi.mock('@@/js/config.js', () => ({ host: 'g.test' }));
vi.mock('@/utility/synced-reaction-aliases.js', () => ({ useSyncedReactionAliases: () => shallowRef({ ':cat@r.test:': ':cat@.:' }) }));
vi.mock('@/utility/extended-reactions.js', () => ({ addExtendedReaction: mocks.add, deleteExtendedReaction: mocks.remove, fetchReactionUsers: mocks.fetch }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false, dataSaver: {}, confirmOnReact: false } } }));
vi.mock('@/i.js', () => ({ $i: { id: 'me' } }));
vi.mock('@/custom-emojis.js', () => ({ customEmojisMap: new Map([['cat', {}]]) }));
vi.mock('@/os.js', () => ({ confirm: mocks.confirm, popupMenu: mocks.menu, alert: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(), misskeyApiGet: vi.fn() }));
vi.mock('@/composables/use-tooltip.js', () => ({ useTooltip: vi.fn() }));
vi.mock('@/utility/emoji-mute.js', () => ({ checkMuted: () => ({ value: false }), mute: vi.fn(), unmute: vi.fn() }));
vi.mock('@/utility/emoji-palette.js', () => ({ addToEmojiPalette: vi.fn() }));
vi.mock('@/utility/media-proxy.js', () => ({ getStaticImageUrl: (url: string) => url }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
vi.mock('@/utility/haptic.js', () => ({ haptic: vi.fn() }));
vi.mock('@/store.js', () => ({ store: {} }));
vi.mock('@/composables/use-note-capture.js', () => ({ noteEvents: { emit: vi.fn() } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { more: 'More', info: 'Info', emojiMute: 'Mute', addToEmojiPalette: 'Palette', cancelReactionConfirm: 'Remove?' }, tsx: {} } }));
vi.mock('@/components/MkCustomEmojiDetailedDialog.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkReactionsViewer.details.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: { props: ['reaction'], template: '<span>{{ reaction }}</span>' } }));
vi.mock('@/components/MkReactionEffect.vue', () => ({ default: { template: '<div/>' } }));

beforeEach(() => { vi.clearAllMocks(); mocks.confirm.mockResolvedValue({ canceled: false }); mocks.fetch.mockResolvedValue([]); mocks.add.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined); });
afterEach(cleanup);
const base = { noteId: 'note', reactions: { ':cat@r.test:': 1, ':cat@.:': 1 }, reactionEmojis: {}, myReaction: null, extendedReactions: true };
const global = { directives: { ripple: {} }, stubs: { MkAvatar: { props: ['user'], template: '<span :data-user="user.id"/>' } } };

test('one button adds the local emoji and fetches avatars for both raw keys', async () => {
	mocks.fetch.mockImplementation(async (_id, reaction) => [{ user: { id: reaction } }]);
	const view = render(Viewer, { props: base, global });
	expect(view.getAllByRole('button')).toHaveLength(1);
	await vi.waitFor(() => expect(view.container.querySelectorAll('[data-user]')).toHaveLength(2));
	await fireEvent.click(view.getByRole('button'));
	expect(mocks.add).toHaveBeenCalledWith('note', ':cat@.:');
});

test('selected grouped reactions remove the original keys after one confirmation', async () => {
	const view = render(Viewer, { props: { ...base, myReactions: [':cat@r.test:', ':cat@.:'] }, global });
	expect(view.getByRole('button').getAttribute('aria-pressed')).toBe('true');
	await fireEvent.click(view.getByRole('button'));
	await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
	expect(mocks.remove.mock.calls).toEqual([['note', ':cat@r.test:'], ['note', ':cat@.:']]);
	expect(mocks.confirm).toHaveBeenCalledTimes(1);
});

test('delegated actions add the viewing server emoji, while lists keep both source keys', async () => {
	const transport = { canToggle: () => true, toggle: vi.fn(), previews: () => [], users: vi.fn(async () => []), showUsers: vi.fn() };
	const view = render(Viewer, { props: { ...base, reactions: { ':cat@.:': 1, ':cat@g.test:': 1 }, reactionHost: 'r.test', transport }, global });
	expect(view.getAllByRole('button')).toHaveLength(1);
	await fireEvent.click(view.getByRole('button'));
	expect(transport.toggle).toHaveBeenCalledWith(':cat@g.test:');
	await fireEvent.contextMenu(view.getByRole('button'));
	mocks.menu.mock.calls[0][0].find((item: { text: string }) => item.text === 'More').action();
	expect(transport.showUsers).toHaveBeenCalledWith([':cat@.:', ':cat@g.test:']);
});
