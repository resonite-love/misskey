/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { render } from '@testing-library/vue';
import Play from '@/pages/flash/flash-index.vue';
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/utility/paginator.js', () => ({ Paginator: class { constructor(public endpoint: string) {} } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _play: {} } } }));
test('uses the page-window router prop even when the browser address stays elsewhere', async () => {
 window.history.replaceState({}, '', '/deck');
 const view = render(Play, { props: { initialTab: 'my' }, global: { stubs: {
  PageWithHeader: { props: ['tab'], template: '<div :data-tab="tab"><slot/></div>' },
  MkPagination: { props: ['paginator'], template: '<div :data-endpoint="paginator.endpoint"/>' }, MkButton: true, MkInput: true,
 } } });
 expect(view.container.querySelector('[data-tab]')?.getAttribute('data-tab')).toBe('my');
 expect(view.container.querySelector('[data-endpoint]')?.getAttribute('data-endpoint')).toBe('flash/my');
 await view.rerender({ initialTab: 'featured' });
 expect(view.container.querySelector('[data-endpoint]')?.getAttribute('data-endpoint')).toBe('flash/featured');
 view.unmount(); window.history.replaceState({}, '', '/');
});
