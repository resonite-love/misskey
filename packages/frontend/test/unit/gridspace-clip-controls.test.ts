/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import ClipNotes from '@/components/MkGridspaceNoteList.vue';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/events.js', () => ({ useGlobalEvent: () => {} }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { enablePullToRefresh: false } } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _gridspace: {} } } }));
vi.mock('@/composables/use-note.js', () => ({ checkNoteWordMute: () => false }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkPullToRefresh.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/components/MkNote.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkGridspacePrivateNoteRow.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkTimelineLoadMore.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPaginationControl.vue', () => ({ default: {
 props: ['paginator'],
 template: `<div><button @click="paginator.searchQuery.value = 'needle'; paginator.reload()">Search</button><button @click="paginator.order.value = 'oldest'; paginator.initialDate = 123; paginator.reload()">Oldest</button><button @click="paginator.reload()">Reload</button></div>`,
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('clip controls commit search and date/order once, then allow an explicit refresh', async () => {
 api.mockImplementation(async (endpoint: string) => endpoint === 'gridspace/collections' ? { enabled: true, clips: true } : endpoint === 'gridspace/private-grant' ? { available: true, granted: true } : { notes: [], cursor: null, observedAt: new Date().toISOString(), scannedThrough: null });
 const view = render(ClipNotes, { props: { source: { kind: 'clip', clipId: 'clip' }, withControl: true }, global: { stubs: { MkLoading: true } } });
 await vi.waitFor(() => expect(api.mock.calls.filter(([path]) => path === 'gridspace/private-notes')).toHaveLength(1));
 api.mockClear();
 await fireEvent.click(view.getByRole('button', { name: 'Search' }));
 await vi.waitFor(() => expect(api.mock.calls.filter(([path]) => path === 'gridspace/private-notes')).toHaveLength(1));
 expect(api.mock.calls.find(([path]) => path === 'gridspace/private-notes')?.[1]).toMatchObject({ query: 'needle', order: 'newest' });
 api.mockClear();
 await fireEvent.click(view.getByRole('button', { name: 'Oldest' }));
 await vi.waitFor(() => expect(api.mock.calls.filter(([path]) => path === 'gridspace/private-notes')).toHaveLength(1));
 expect(api.mock.calls.find(([path]) => path === 'gridspace/private-notes')?.[1]).toMatchObject({ query: 'needle', order: 'oldest', rangeStartAt: 123 });
 api.mockClear();
 await fireEvent.click(view.getByRole('button', { name: 'Reload' }));
 await vi.waitFor(() => expect(api.mock.calls.filter(([path]) => path === 'gridspace/private-notes')).toHaveLength(1));
});
