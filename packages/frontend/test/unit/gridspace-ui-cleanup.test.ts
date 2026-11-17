/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type { RenderResult } from '@testing-library/vue';
import type { NotificationGroup } from '@/utility/use-gridspace-notifications.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import MkGridspaceListImport from '@/components/MkGridspaceListImport.vue';
import MkGridspaceNotification from '@/components/MkGridspaceNotification.vue';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/cache.js', () => ({ userListsCache: { delete: vi.fn(), fetch: vi.fn() }, antennasCache: { delete: vi.fn(), fetch: vi.fn() } }));
vi.mock('@/i18n.js', () => ({ i18n: {
	ts: new Proxy({}, { get: (_, key) => key === '_gridspace' ? new Proxy({}, { get: (__, name) => String(name) }) : key === '_notification' ? { _types: { receiveFollowRequest: 'Follow request' } } : String(key) }),
	tsx: { _gridspace: { listsProgressOnly: () => 'List progress', listsProgress: () => 'Legacy progress' } },
} }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<p><slot/></p>' } }));
vi.mock('@/components/MkNotificationLayout.vue', () => ({ default: { template: '<div><slot name="head"/><slot name="header"/><slot/></div>' } }));
vi.mock('@/components/MkFollowRequestActions.vue', () => ({ default: { emits: ['decide'], template: '<button @click="$emit(\'decide\', true)">Accept</button>' } }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: { template: '<span/>' } }));

let view: RenderResult | undefined;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await nextTick(); };
const state = { started: true, complete: true, total: 2, done: 2, failed: 0, pending: 0, skipped: 0 };
const stubs = { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkAvatar: true, MkUserName: true, Mfm: true };

beforeEach(() => {
	vi.mocked(misskeyApi).mockReset();
	vi.mocked(misskeyApi).mockImplementation(async endpoint => (endpoint === 'gridspace/link' ? { channelsEnabled: true, initiator: true, state: 'active', driveShared: true } : state) as never);
});
afterEach(() => { view?.unmount(); view = undefined; });

describe('migration status in ordinary lists', () => {
	it('hides a completed migration and never restarts it from the list page', async () => {
		view = render(MkGridspaceListImport, { props: { summaryOnly: true }, global: { stubs } }); await flush();
		expect(view.container.textContent).toBe('');
		expect(vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === 'gridspace/list-import').map(([, data]) => data)).toEqual([{ action: 'status' }]);
	});
	it('shows pending or failed status with a link to settings, without executing migration steps', async () => {
		vi.mocked(misskeyApi).mockImplementation(async endpoint => (endpoint === 'gridspace/link' ? { channelsEnabled: true, initiator: true, state: 'active', driveShared: true } : { ...state, complete: false, pending: 1, failed: 1 }) as never);
		view = render(MkGridspaceListImport, { props: { summaryOnly: true }, global: { stubs } }); await flush();
		expect(view.container.querySelector('a')?.getAttribute('href')).toBe('/settings/gridspace');
		expect(view.container.textContent).toContain('List progress');
		expect(view.container.querySelector('button')).toBeNull();
		expect(vi.mocked(misskeyApi).mock.calls).toHaveLength(2);
	});
	it('offers setup for a migration that has not started without starting it automatically', async () => {
		vi.mocked(misskeyApi).mockImplementation(async endpoint => (endpoint === 'gridspace/link' ? { channelsEnabled: true, initiator: true, state: 'active', driveShared: true } : { ...state, started: false, complete: false }) as never);
		view = render(MkGridspaceListImport, { props: { summaryOnly: true }, global: { stubs } }); await flush();
		expect(view.container.querySelector('a')?.getAttribute('href')).toBe('/settings/gridspace');
		expect(view.container.querySelector('button')).toBeNull();
		expect(vi.mocked(misskeyApi).mock.calls).toHaveLength(2);
	});
	it('keeps the migration control available in settings and hides it after completion', async () => {
		vi.mocked(misskeyApi).mockImplementation(async (endpoint, data) => (endpoint === 'gridspace/link' ? { channelsEnabled: true, initiator: true, state: 'active', driveShared: true } : (data as { action?: string } | undefined)?.action === 'start' ? state : { ...state, started: false, complete: false }) as never);
		view = render(MkGridspaceListImport, { global: { stubs } }); await flush();
		await fireEvent.click(view.getByText('listsCopyOnly')); await flush();
		expect(vi.mocked(misskeyApi).mock.calls).toContainEqual(['gridspace/list-import', { action: 'start' }]);
		expect(view.container.querySelector('button')).toBeNull();
		expect(view.container.textContent).toContain('List progress');
	});
});

function requestRow(canManage: boolean): NotificationGroup & { source: 'peer' } {
	return { id: 'request', source: 'peer', origin: 'https://peer.example', createdAt: '2026-11-17T00:00:00Z', members: [], remote: { type: 'receiveFollowRequest', note: null, presentation: { followRequestId: 'follow', canManageFollowRequest: canManage } } } as unknown as NotificationGroup & { source: 'peer' };
}

describe('follow request notification links', () => {
	it('retains inline approval while hiding the redundant remote link', async () => {
		view = render(MkGridspaceNotification, { props: { row: requestRow(true) }, global: { stubs } });
		expect(view.container.querySelector('a[target="_blank"]')).toBeNull();
		await fireEvent.click(view.getByText('Accept')); await flush();
		expect(misskeyApi).toHaveBeenCalledWith('gridspace/notifications/follow-request', { notificationId: 'request', followRequestId: 'follow', accept: true }, undefined, expect.any(AbortSignal));
	});
	it('retains the remote link when inline approval is unavailable', () => {
		view = render(MkGridspaceNotification, { props: { row: requestRow(false) }, global: { stubs } });
		expect(view.container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://peer.example/my/follow-requests');
		expect(view.queryByText('Accept')).toBeNull();
	});
	it('retains the remote link when permission exists but the request cannot be resolved', () => {
		const row = requestRow(true);
		row.remote.presentation!.followRequestId = null;
		view = render(MkGridspaceNotification, { props: { row }, global: { stubs } });
		expect(view.container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://peer.example/my/follow-requests');
		expect(view.queryByText('Accept')).toBeNull();
	});
});
