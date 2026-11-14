/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import Content from '@/components/MkGridspaceContentList.vue';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { enablePullToRefresh: false } } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer' } }));
vi.mock('@/components/MkClipPreview.vue', () => ({ default: { props: ['clip', 'peerOrigin'], template: '<a :href="`/clips/${clip.id}${peerOrigin ? `/linked` : ``}`">{{ clip.name }}</a>' } }));
vi.mock('@/components/MkPagePreview.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkGalleryPostPreview.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkTimelineLoadMore.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkPullToRefresh.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/components/MkPaginationControl.vue', () => ({ default: { props: ['paginator'], template: '<button @click="paginator.order.value = `oldest`; paginator.reload()">Oldest</button>' } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('profile clips combine both accounts, preserve source links and sort together', async () => {
 const clip = (name: string, createdAt: string, gridspaceOrigin?: string) => ({ id: name, name, createdAt, gridspaceOrigin });
 api.mockImplementation(async (path: string) => {
  if (path === 'gridspace/member') return { accounts: [{ id: 'localOwner', host: null }] };
  if (path === 'users/clips') return [clip('local', '2026-11-15T00:00:00Z')];
  if (path === 'gridspace/content') return { clips: [clip('peer', '2026-11-14T00:00:00Z', 'https://r.example')], next: null };
  throw Error(path);
 });
 const view = render(Content, { props: { kind: 'clips', userId: 'remoteProfile' }, global: { stubs: { MkLoading: true, MkResult: true, MkError: true } } });
 await vi.waitFor(() => expect(view.getAllByRole('link').map(link => link.textContent)).toEqual(['local', 'peer']));
 expect(view.getByRole('link', { name: 'peer' }).getAttribute('href')).toBe('/clips/peer/linked');
 expect(api).toHaveBeenCalledWith('users/clips', expect.objectContaining({ userId: 'localOwner' }));
 expect(api).toHaveBeenCalledWith('gridspace/content', expect.objectContaining({ kind: 'clips', userId: 'remoteProfile' }));
 await fireEvent.click(view.getByRole('button', { name: 'Oldest' }));
 await vi.waitFor(() => expect(view.getAllByRole('link').map(link => link.textContent)).toEqual(['peer', 'local']));
});

test('a peer outage keeps the local public profile clips visible', async () => {
 api.mockImplementation(async (path: string) => {
  if (path === 'gridspace/member') return { accounts: [] };
  if (path === 'users/clips') return [{ id: 'local', name: 'local', createdAt: '2026-11-15T00:00:00Z' }];
  throw Error('offline');
 });
 const view = render(Content, { props: { kind: 'clips', userId: 'owner' }, global: { stubs: { MkLoading: true, MkResult: true, MkError: { template: '<div role="alert">Error</div>' } } } });
 await vi.waitFor(() => expect(view.getByRole('link', { name: 'local' })).toBeTruthy());
 expect(view.getByRole('alert')).toBeTruthy();
});
