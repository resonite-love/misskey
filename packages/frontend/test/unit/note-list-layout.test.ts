/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { h } from 'vue';
import { cleanup, render } from '@testing-library/vue';
import Layout from '@/components/MkNoteListLayout.vue';
vi.mock('@/i18n.js', () => ({ i18n: { ts: {} } }));
afterEach(cleanup);
const items = [{ id: 'local', createdAt: '2026-11-15T03:00:00Z' }, { id: 'private', createdAt: '2026-11-13T03:00:00Z' }];
const props = { items, getKey: (item: unknown) => (item as typeof items[number]).id, getDate: (item: unknown) => (item as typeof items[number]).createdAt };

test('both note sources use the same card frames, anchors and date separation', async () => {
 const view = render(Layout, { props, slots: { default: ({ item }: { item: typeof items[number] }) => h('article', item.id), after: ({ item }: { item: typeof items[number] }) => item.id === 'local' ? h('aside', 'Ad') : null } });
 expect(view.container.querySelectorAll('[data-note-list-item]')).toHaveLength(2);
 expect([...view.container.querySelectorAll('[data-scroll-anchor]')].map(el => el.getAttribute('data-scroll-anchor'))).toEqual(['local', 'private']);
 expect(view.getByText('11/15')).toBeTruthy(); expect(view.getByText('11/13')).toBeTruthy(); expect(view.getByText('Ad')).toBeTruthy();
 await view.rerender({ items: [{ ...items[1] }] });
 expect(view.queryByText('local')).toBeNull(); expect(view.queryByText('11/15')).toBeNull();
 expect(view.getByText('private')).toBeTruthy();
});

test('a suspended body can remain in its frame without exposing its prior contents', async () => {
 const view = render(Layout, { props: { ...props, noGap: true, dateSeparators: false }, slots: { default: () => h('div', { 'aria-busy': 'true', style: 'height: 180px;' }) } });
 expect(view.container.querySelectorAll('[data-note-list-item]')).toHaveLength(2);
 expect(view.queryByText('11/15')).toBeNull(); expect(view.container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
});
