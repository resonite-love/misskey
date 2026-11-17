/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import EmojiPickerDialog from '@/components/MkEmojiPickerDialog.vue';

vi.mock('@/components/MkModal.vue', async () => {
	const { defineComponent, h, ref } = await import('vue');
	return { default: defineComponent({
		emits: ['close', 'closed', 'click', 'esc', 'opening'],
		setup(_, { slots, emit, expose }) {
			const visible = ref(true);
			expose({ close: () => { visible.value = false; emit('close'); emit('closed'); } });
			return () => visible.value ? h('div', { 'data-testid': 'picker-modal' }, slots.default?.({ type: 'popup', maxHeight: 600 })) : null;
		},
	}) };
});
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	return { prefer: { s: { animation: false, emojiPickerStyle: 'popup' }, r: {
		emojiPickerScale: ref(1), emojiPickerWidth: ref(1), emojiPickerHeight: ref(1),
	} } };
});
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	const recent = ref([':beta:']);
	return { store: { r: { recentlyUsedEmojis: recent }, s: { get recentlyUsedEmojis() { return recent.value; }, additionalUnicodeEmojiIndexes: {} }, set: (_key: string, value: string[]) => { recent.value = value; } } };
});
vi.mock('@/custom-emojis.js', async () => {
	const { ref } = await import('vue');
	const emojis = ['alpha', 'beta'].map(name => ({ name, aliases: [], category: 'test/nested', url: '/emoji.png' }));
	return { customEmojis: ref(emojis), customEmojisMap: new Map(emojis.map(emoji => [emoji.name, emoji])), customEmojiCategories: ref(['test/nested']), addCustomEmoji: vi.fn() };
});
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/i.js', () => ({ $i: { id: 'self' } }));
vi.mock('@/utility/haptic.js', () => ({ haptic: vi.fn() }));
vi.mock('@/utility/check-reaction-permissions.js', () => ({ checkReactionPermissions: () => true }));
vi.mock('@/utility/extended-reactions.js', () => ({ addExtendedReaction: vi.fn(), supportsExtendedReactions: () => true }));
vi.mock('@/composables/use-note-capture.js', () => ({ noteEvents: { emit: vi.fn() } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/os.js', () => ({ popup: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: { template: '<div/>' } }));

afterEach(cleanup);

function picker(props = {}) {
	return render(EmojiPickerDialog, { props: { asReactionPicker: true, pinnedEmojis: [':alpha:'], ...props }, global: {
		stubs: { MkCustomEmoji: true, MkEmoji: true }, directives: { tooltip: {}, panel: {} },
	} });
}

describe('Shift reaction selection', () => {
	test('keeps the same picker open for consecutive choices, then closes without Shift', async () => {
		const view = picker();
		await fireEvent.click(view.container.querySelector('[data-emoji=":alpha:"]')!, { shiftKey: true });
		await fireEvent.click(view.container.querySelector('[data-emoji=":beta:"]')!, { shiftKey: true });
		expect(view.emitted().done).toEqual([[':alpha:'], [':beta:']]);
		expect(view.getByTestId('picker-modal')).toBeTruthy();
		await fireEvent.click(view.container.querySelector('[data-emoji=":alpha:"]')!);
		expect(view.emitted().done).toHaveLength(3);
		expect(view.queryByTestId('picker-modal')).toBeNull();
	});

	test('passes Shift through search results and nested emoji categories', async () => {
		const view = picker();
		await fireEvent.update(view.getByRole('searchbox'), 'alpha');
		await fireEvent.click(view.container.querySelector('button[title="alpha"]')!, { shiftKey: true });
		expect(view.getByTestId('picker-modal')).toBeTruthy();
		await fireEvent.update(view.getByRole('searchbox'), '');
		await fireEvent.click(view.getByText('test', { exact: false }));
		await fireEvent.click(view.getByText('nested', { exact: false }));
		await fireEvent.click(view.getByText('nested', { exact: false }).closest('section')!.querySelector('[data-emoji=":beta:"]')!, { shiftKey: true });
		expect(view.emitted().done).toEqual([[':alpha:'], [':beta:']]);
		expect(view.getByTestId('picker-modal')).toBeTruthy();
	});

	test.each(['alpha', '👍', 'alp'])('keeps search open on Shift+Enter for %s', async query => {
		const view = picker();
		await fireEvent.update(view.getByRole('searchbox'), query);
		await fireEvent.keyDown(view.getByRole('searchbox'), { key: 'Enter', shiftKey: true });
		expect(view.emitted().done).toHaveLength(1);
		expect(view.getByTestId('picker-modal')).toBeTruthy();
		await fireEvent.keyDown(view.getByRole('searchbox'), { key: 'Enter' });
		expect(view.emitted().done).toHaveLength(2);
		expect(view.queryByTestId('picker-modal')).toBeNull();
	});

	test('does not change single-selection dialogs unrelated to reactions', async () => {
		const view = picker({ asReactionPicker: false });
		await fireEvent.click(view.container.querySelector('[data-emoji=":alpha:"]')!, { shiftKey: true });
		expect(view.queryByTestId('picker-modal')).toBeNull();
	});

	test('preserves persistent composition pickers and Escape dismissal', async () => {
		const view = picker({ asReactionPicker: false, choseAndClose: false });
		await fireEvent.click(view.container.querySelector('[data-emoji=":alpha:"]')!);
		expect(view.getByTestId('picker-modal')).toBeTruthy();
		await fireEvent.keyDown(view.getByRole('searchbox'), { key: 'Escape', shiftKey: true });
		expect(view.queryByTestId('picker-modal')).toBeNull();
	});
});
