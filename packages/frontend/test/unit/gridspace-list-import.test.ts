/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import ListImport from '@/components/MkGridspaceListImport.vue';
const { api, state } = vi.hoisted(() => ({ api: vi.fn(), state: { started: true, complete: true, total: 2, done: 1, skipped: 1, failed: 0, pending: 0 } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/cache.js', () => ({ userListsCache: { delete: vi.fn(), fetch: vi.fn() }, antennasCache: { delete: vi.fn(), fetch: vi.fn() } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { retry: 'Retry', _gridspace: { listsCopy: 'Copy', listsSkipped: 'Gone account skipped', listsCopyFailed: 'Failed' } }, tsx: { _gridspace: { listsProgress: ({done, total, failed, skipped}: {done:number;total:number;failed:number;skipped:number}) => `${done}/${total}, skipped ${skipped}, failed ${failed}` } } } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
test('shows completed-with-skips without an error or a retry button', async () => {
 api.mockImplementation(async (path: string) => path === 'gridspace/link' ? { channelsEnabled: true, initiator: true, state: 'active' } : state);
 const view = render(ListImport);
 await vi.waitFor(() => expect(view.getByText('1/2, skipped 1, failed 0')).toBeTruthy());
 expect(view.getByText('Gone account skipped')).toBeTruthy();
 expect(view.queryByText('Failed')).toBeNull(); expect(view.queryByText('Retry')).toBeNull();
 expect((view.getByText('Copy') as HTMLButtonElement).disabled).toBe(true);
});
test('accepts an older response without a skipped count', async () => {
 api.mockImplementation(async (path: string) => path === 'gridspace/link' ? { channelsEnabled: true, initiator: true, state: 'active' } : { ...state, done: 2, skipped: undefined });
 const view = render(ListImport);
 await vi.waitFor(() => expect(view.getByText('2/2, skipped 0, failed 0')).toBeTruthy());
 expect(view.queryByText('Gone account skipped')).toBeNull();
});
