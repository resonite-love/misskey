/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import DirectUpload from '@/pages/neos/direct-upload.vue';

const mocks = vi.hoisted(() => ({ api: vi.fn(), on: vi.fn(), dispose: vi.fn() }));

vi.mock('@/i18n.js', () => ({
	i18n: { ts: { processing: 'Processing', done: 'Done', error: 'Error', invalidParamError: 'Invalid parameter' } },
}));
vi.mock('@/preferences.js', () => ({ prefer: { s: { uploadFolder: 'folder-id' } } }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => ({ on: mocks.on, dispose: mocks.dispose }) }) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));

function open(query: Record<string, string>) {
	window.history.replaceState({}, '', '/neos/directupload?' + new URLSearchParams(query));
	return render(DirectUpload);
}

describe('direct-upload delivery options', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(window, 'close').mockImplementation(() => {});
		mocks.api.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	test.each([
		[{}, { visibility: 'public', localOnly: false, noRelay: false }],
		[{ noRelay: 'true' }, { visibility: 'public', localOnly: false, noRelay: true }],
		[{ visibility: 'home', localOnly: 'true', noRelay: 'false' }, { visibility: 'home', localOnly: true, noRelay: false }],
		[{ visibility: 'followers', localOnly: 'true', noRelay: 'true' }, { visibility: 'followers', localOnly: true, noRelay: true }],
	])('posts text with delivery parameters %j', async (params, expected) => {
		open({ noteText: '50% complete', imageUrl: 'null', ...params });
		await vi.advanceTimersByTimeAsync(1000);

		expect(mocks.api).toHaveBeenCalledExactlyOnceWith('notes/create', {
			text: '50% complete',
			fileIds: undefined,
			visibleUserIds: undefined,
			...expected,
		});
		expect(mocks.on).not.toHaveBeenCalled();
	});

	test('uses the same options after the matching image upload finishes', async () => {
		const imageUrl = 'https://example.com/photo test.png';
		const noteText = '画像付きの投稿';
		open({ imageUrl: encodeURIComponent(imageUrl), noteText: encodeURIComponent(noteText), noRelay: 'true' });
		await vi.advanceTimersByTimeAsync(1000);

		const marker = mocks.api.mock.calls[0][1].marker;
		expect(mocks.api).toHaveBeenCalledExactlyOnceWith('drive/files/upload-from-url', {
			url: imageUrl,
			folderId: 'folder-id',
			marker,
		});
		const notify = mocks.on.mock.calls[0][1];
		notify({ marker: 'unrelated', file: { id: 'unrelated-image' } });
		expect(mocks.api).toHaveBeenCalledTimes(1);
		notify({ marker, file: { id: 'uploaded-image' } });
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.api).toHaveBeenLastCalledWith('notes/create', {
			text: noteText,
			fileIds: ['uploaded-image'],
			visibility: 'public',
			localOnly: false,
			noRelay: true,
			visibleUserIds: undefined,
		});
		expect(mocks.dispose).toHaveBeenCalledTimes(1);
	});

	test('passes recipient IDs when the specified visibility is selected', async () => {
		open({ noteText: 'Private note', visibility: 'specified', visibleUserIds: 'user1,user2' });
		await vi.advanceTimersByTimeAsync(1000);

		expect(mocks.api).toHaveBeenCalledExactlyOnceWith('notes/create', expect.objectContaining({
			visibility: 'specified',
			visibleUserIds: ['user1', 'user2'],
		}));
	});

	test('rejects an unknown visibility before uploading or posting', async () => {
		const view = open({ imageUrl: 'https://example.com/photo.png', noteText: 'Private note', visibility: 'follower' });
		await vi.advanceTimersByTimeAsync(1000);

		expect(view.getByRole('status').textContent).toContain('Invalid parameter');
		expect(mocks.api).not.toHaveBeenCalled();
		expect(mocks.on).not.toHaveBeenCalled();
	});
});
