/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import EmojiSync from '@/components/MkGridspaceEmojiSync.vue';

const mocks = vi.hoisted(() => ({ api: vi.fn(), action: vi.fn(), confirm: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.action, confirm: mocks.confirm }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><slot name="label"/><slot/></section>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<p><slot/></p>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { reload: 'Reload', loadMore: 'More', _gridspaceEmojiSync: { title: 'Emoji sync', description: 'Description', failedToLoad: 'Unavailable', lastChecked: 'Checked', retry: 'Retry', manage: 'Manage', disabled: 'Disabled', noIssues: 'No issues', pending: 'Pending', conflict: 'Conflict', failed: 'Failed', ignored: 'Ignored', different: 'Different', notPresent: 'Absent', ignore: 'Ignore', resume: 'Resume' } }, tsx: { _gridspaceEmojiSync: { counts: () => 'Counts', adopt: ({ host }: { host: string }) => `Use ${host}`, confirm: ({ name, host }: { name: string; host: string }) => `Replace with ${name} from ${host}?` } } } }));

const metadata = { category: 'cats', aliases: ['kitty'], license: 'CC0', isSensitive: false, localOnly: false, restricted: false };
const snapshot = () => ({ enabled: true, originA: 'https://a.test', originB: 'https://b.test', checkedAt: null, lastError: null, next: null, counts: { synced: 10, pending: 0, conflict: 1, failed: 0, ignored: 0 }, items: [{ id: 'conflict-id', state: 'conflict', reason: 'CONFLICT', attempts: 0, retryAt: '', a: { ...metadata, id: 'a', name: 'cat-a', originalUrl: 'https://a.test/a.png', hash: 'hash-a' }, b: { ...metadata, category: 'different category', id: 'b', name: 'cat-b', originalUrl: 'https://b.test/b.png', hash: 'hash-b' } }] });
beforeEach(() => { vi.clearAllMocks(); mocks.api.mockResolvedValue(snapshot()); mocks.confirm.mockResolvedValue({ canceled: false }); mocks.action.mockResolvedValue({ ...snapshot(), items: [] }); });
afterEach(cleanup);

test('shows both versions and confirms the exact snapshot before replacing one', async () => {
	const view = render(EmojiSync);
	await vi.waitFor(() => expect(view.getByText('cat-a')).toBeTruthy());
	expect(view.getByText('different category')).toBeTruthy();
	await fireEvent.click(view.getByText('Use b.test'));
	await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledWith('admin/gridspace/emojis', { action: 'preferB', id: 'conflict-id', expectedA: 'hash-a', expectedB: 'hash-b' }));
	expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: 'Replace with cat-b from b.test?' });
});
test('cancelling does not submit a replacement', async () => {
	mocks.confirm.mockResolvedValue({ canceled: true });
	const view = render(EmojiSync); await vi.waitFor(() => expect(view.getByText('cat-a')).toBeTruthy());
	await fireEvent.click(view.getByText('Use a.test')); expect(mocks.action).not.toHaveBeenCalled();
});
test('keeps previous status visible on a failed refresh', async () => {
	const view = render(EmojiSync); await vi.waitFor(() => expect(view.getByText('cat-a')).toBeTruthy());
	mocks.api.mockRejectedValueOnce(Error('offline')); await fireEvent.click(view.getByText('Reload'));
	await vi.waitFor(() => expect(view.getByText('Unavailable')).toBeTruthy()); expect(view.getByText('cat-a')).toBeTruthy();
	await fireEvent.click(view.getByText('Retry'));
	await vi.waitFor(() => expect(view.queryByText('Unavailable')).toBeNull());
});
test('loads additional pages without removing earlier conflicts', async () => {
	mocks.api.mockResolvedValueOnce({ ...snapshot(), next: 'next' }).mockResolvedValueOnce({ ...snapshot(), items: [{ ...snapshot().items[0], id: 'second', a: { ...snapshot().items[0].a, name: 'second-cat' } }] });
	const view = render(EmojiSync); await vi.waitFor(() => expect(view.getByText('More')).toBeTruthy());
	await fireEvent.click(view.getByText('More')); await vi.waitFor(() => expect(view.getByText('second-cat')).toBeTruthy());
	expect(view.getByText('cat-a')).toBeTruthy(); expect(mocks.api).toHaveBeenLastCalledWith('admin/gridspace/emojis', { action: 'status', after: 'next' }, undefined, expect.anything());
});
