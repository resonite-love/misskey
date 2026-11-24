/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import MkMenu from '@/components/MkMenu.vue';
import type { MenuButton } from '@/types/menu.js';

vi.mock('@/os.js', () => ({}));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { none: 'Empty' } } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {} } }));
vi.mock('@/utility/touch.js', () => ({ isTouchUsing: false }));
const options = { global: { directives: { hotkey: {} }, stubs: { MkEllipsis: { template: '<span>Pending</span>' } } } };
const button = (text: string): MenuButton => ({ text, action: vi.fn() });
afterEach(cleanup);

test('hides an unavailable asynchronous action without shifting the remaining resolutions', async () => {
	let hide!: (item: null) => void, show!: (item: MenuButton) => void;
	const view = render(MkMenu, { ...options, props: { items: [button('Before'), new Promise<null>(resolve => { hide = resolve; }), new Promise<MenuButton>(resolve => { show = resolve; })] } });
	hide(null); await nextTick(); await nextTick();
	show(button('Delete')); await nextTick(); await nextTick();
	expect(view.getByText('Before')).toBeTruthy();
	expect(view.getByText('Delete')).toBeTruthy();
	expect(view.queryByText('Pending')).toBeNull();
});

test('ignores an old asynchronous action after the menu is replaced', async () => {
	let finish!: (item: MenuButton) => void;
	const view = render(MkMenu, { ...options, props: { items: [new Promise<MenuButton>(resolve => { finish = resolve; })] } });
	await view.rerender({ items: [button('Current')] });
	finish(button('Old delete')); await nextTick(); await nextTick();
	expect(view.getByText('Current')).toBeTruthy();
	expect(view.queryByText('Old delete')).toBeNull();
});

test('keeps the focused action attached to its button when an earlier entry disappears', async () => {
	let hide!: (item: null) => void;
	const keep = button('Keep focus'), danger = button('Danger action');
	const view = render(MkMenu, { ...options, props: { items: [new Promise<null>(resolve => { hide = resolve; }), keep, danger] } });
	await nextTick(); await nextTick();
	const focused = view.getByRole('menuitem', { name: 'Keep focus' });
	focused.focus();
	hide(null); await nextTick(); await nextTick();
	expect(document.activeElement).toBe(focused);
	expect(focused.textContent).toContain('Keep focus');
	await fireEvent.click(focused);
	expect(keep.action).toHaveBeenCalledOnce();
	expect(danger.action).not.toHaveBeenCalled();
});
