/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/vue';
import { nextTick, reactive } from 'vue';
import type { RenderResult } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import MkMediaResonitePackage from '@/components/MkMediaResonitePackage.vue';
import { isResonitePackageFile, packageDownloadUrl, readResonitePackageInfo } from '@/utility/resonite-package.js';
import type { ResonitePackageInfo } from '@/utility/resonite-package.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), reveal: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/i.js', () => ({ $i: { id: 'owner' } }));
vi.mock('@/utility/sensitive-file.js', () => ({
	shouldHideFileByDefault: (file: { isSensitive: boolean }) => file.isSensitive,
	canRevealFile: mocks.reveal,
}));
vi.mock('@/i18n.js', () => ({ i18n: { ts: {
	download: 'Download', loading: 'Loading', retry: 'Retry', sensitive: 'Sensitive', clickToShow: 'Show',
	_resonitePackage: { format: 'ResonitePackage', assets: 'Assets', slots: 'Slots', components: 'Components', unpackedSize: 'Unpacked size', unknown: 'Unknown', showContents: 'Show contents', unavailable: 'Cannot read contents. Download is available.' },
} } }));

const info: ResonitePackageInfo = {
	schemaVersion: 1, name: 'Misskey Client', recordCount: 1, assetCount: 12, assetBytes: 1024,
	unpackedBytes: 2048, variantCount: 0, slotCount: 48, componentCount: 216,
	thumbnailDataUrl: 'data:image/webp;base64,UklGRg==',
};
const makeFile = (overrides: Partial<entities.DriveFile> = {}) => ({
	id: 'package', name: 'client.resonitepackage', url: 'https://files.example/client.resonitepackage',
	type: 'application/octet-stream', size: 512, isSensitive: false, properties: {}, userId: 'owner', ...overrides,
}) as entities.DriveFile;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Resonite package metadata', () => {
	test('recognizes the final extension regardless of case', () => {
		expect(isResonitePackageFile({ name: 'client.ResonitePackage' })).toBe(true);
		expect(isResonitePackageFile({ name: 'client.resonitepackage.zip' })).toBe(false);
		expect(isResonitePackageFile({ name: 'resonitepackage' })).toBe(false);
	});
	test('accepts zero counts and drops invalid optional counts without inventing zero', () => {
		const result = readResonitePackageInfo({ ...info, assetCount: 0, slotCount: -1, componentCount: '42' });
		expect(result?.assetCount).toBe(0);
		expect(result?.slotCount).toBeUndefined();
		expect(result?.componentCount).toBeUndefined();
		expect(readResonitePackageInfo({ ...info, unpackedBytes: Number.MAX_VALUE })).toBeNull();
		expect(readResonitePackageInfo({ ...info, schemaVersion: 2 })).toBeNull();
	});
	test('only retains bounded embedded WebP thumbnails', () => {
		expect(readResonitePackageInfo(info)?.thumbnailDataUrl).toBe(info.thumbnailDataUrl);
		expect(readResonitePackageInfo({ ...info, thumbnailDataUrl: 'https://tracking.example/image.webp' })?.thumbnailDataUrl).toBeUndefined();
		expect(readResonitePackageInfo({ ...info, thumbnailDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })?.thumbnailDataUrl).toBeUndefined();
		expect(readResonitePackageInfo({ ...info, thumbnailDataUrl: `data:image/webp;base64,${'A'.repeat(72 * 1024)}` })?.thumbnailDataUrl).toBeUndefined();
	});
	test('only exposes the original HTTP download URL', () => {
		expect(packageDownloadUrl('https://files.example/a.resonitepackage')).toBe('https://files.example/a.resonitepackage');
		expect(packageDownloadUrl('/files/a.resonitepackage')).toBe('/files/a.resonitepackage');
		expect(packageDownloadUrl('blob:https://example.com/authorized', true)).toBe('blob:https://example.com/authorized');
		expect(packageDownloadUrl('blob:https://example.com/authorized')).toBeUndefined();
		for (const url of ['', 'javascript:alert(1)', 'data:text/html,a', 'https://user:pass@example.com/a']) expect(packageDownloadUrl(url)).toBeUndefined();
	});
});

describe('Resonite package attachment', () => {
	let wrapper: RenderResult | undefined;

	function create(media = makeFile(), extra: { noteId?: string; ephemeral?: boolean; disableAnalysis?: boolean } = {}) {
		wrapper = render(MkMediaResonitePackage, { props: { media, ...extra } });
		return wrapper;
	}

	beforeEach(() => {
		mocks.api.mockReset();
		mocks.reveal.mockReset();
		mocks.reveal.mockResolvedValue(true);
	});

	afterEach(() => { wrapper?.unmount(); wrapper = undefined; });
	test('renders stored content statistics and the original named download without requesting metadata', () => {
		const media = makeFile({ properties: { resonitePackage: info } });
		const view = create(media);
		expect(view.getByText('Misskey Client')).toBeTruthy();
		expect(view.getByText('12')).toBeTruthy();
		expect(view.getByText('48')).toBeTruthy();
		expect(view.getByText('216')).toBeTruthy();
		expect(view.getByText('2KB')).toBeTruthy();
		expect(view.getByRole('img').getAttribute('src')).toBe(info.thumbnailDataUrl);
		const link = view.getByRole('link', { name: 'Download' });
		expect(link.getAttribute('href')).toBe(media.url);
		expect(link.getAttribute('download')).toBe(media.name);
		expect(link.getAttribute('rel')).toContain('noopener');
		expect(mocks.api).not.toHaveBeenCalled();
	});
	test('labels unavailable object counts as unknown and falls back to the filename', () => {
		const view = create(makeFile({ properties: { resonitePackage: { ...info, name: '', slotCount: undefined, componentCount: undefined } } }));
		expect(view.getAllByText('Unknown')).toHaveLength(2);
		expect(view.getByText('client.resonitepackage', { selector: 'b' })).toBeTruthy();
	});
	test('keeps sensitive metadata, thumbnail and controls hidden until the reveal check allows them', async () => {
		const view = create(makeFile({ isSensitive: true, properties: { resonitePackage: info } }));
		expect(view.queryByText('Misskey Client')).toBeNull();
		expect(view.queryByRole('img')).toBeNull();
		expect(view.queryByRole('link')).toBeNull();
		mocks.reveal.mockResolvedValueOnce(false);
		await fireEvent.click(view.getByRole('button'));
		await flush();
		expect(view.queryByText('Misskey Client')).toBeNull();
		await fireEvent.click(view.getByRole('button'));
		await flush();
		expect(view.getByText('Misskey Client')).toBeTruthy();
		expect(mocks.api).not.toHaveBeenCalled();
	});
	test('does not inspect a sensitive old file until revealed and explicitly requested', async () => {
		mocks.api.mockResolvedValue(info);
		const view = create(makeFile({ isSensitive: true }), { noteId: 'note' });
		await flush();
		expect(mocks.api).not.toHaveBeenCalled();
		await fireEvent.click(view.getByRole('button'));
		await flush();
		expect(mocks.api).not.toHaveBeenCalled();
		await fireEvent.click(view.getByRole('button', { name: 'Show contents' }));
		await flush();
		expect(mocks.api).toHaveBeenCalledWith('drive/files/resonite-package', { fileId: 'package', noteId: 'note' }, undefined, expect.any(AbortSignal));
		expect(view.getByText('Misskey Client')).toBeTruthy();
	});
	test.each([null, new Error('unavailable')])('keeps download working when analysis fails (%s)', async result => {
		if (result instanceof Error) mocks.api.mockRejectedValue(result);
		else mocks.api.mockResolvedValue(result);
		const view = create();
		await fireEvent.click(view.getByRole('button', { name: 'Show contents' }));
		await flush();
		expect(view.getByRole('status').textContent).toContain('Cannot read');
		expect(view.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(makeFile().url);
		mocks.api.mockResolvedValue(info);
		await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
		await flush();
		expect(view.getByText('Misskey Client')).toBeTruthy();
	});
	test('aborts and ignores stale results when a file URL changes', async () => {
		let finish!: (value: ResonitePackageInfo) => void;
		mocks.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		const media = reactive(makeFile());
		const view = create(media);
		await fireEvent.click(view.getByRole('button', { name: 'Show contents' }));
		const signal = mocks.api.mock.calls[0][3] as AbortSignal;
		media.url = 'https://files.example/replaced.resonitepackage';
		await nextTick();
		expect(signal.aborted).toBe(true);
		finish(info);
		await flush();
		expect(view.queryByText('Misskey Client')).toBeNull();
		expect(view.getByRole('button', { name: 'Show contents' })).toBeTruthy();
	});
	test('resets sensitive reveal state when the file changes during confirmation', async () => {
		let confirm!: (value: boolean) => void;
		mocks.reveal.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
		const view = create(makeFile({ isSensitive: true }));
		await fireEvent.click(view.getByRole('button'));
		await view.rerender({ media: makeFile({ id: 'other', isSensitive: true, properties: { resonitePackage: info } }) });
		confirm(true);
		await flush();
		expect(view.queryByText('Misskey Client')).toBeNull();
		expect(view.queryByRole('img')).toBeNull();
	});
	test('replaces analyzed metadata when stored properties change', async () => {
		const media = reactive(makeFile({ properties: { resonitePackage: info } }));
		const view = create(media);
		media.properties.resonitePackage = { ...info, name: 'Replacement' };
		await nextTick();
		expect(view.queryByText('Misskey Client')).toBeNull();
		expect(view.getByText('Replacement')).toBeTruthy();
	});
	test('aborts a pending request on unmount and ignores its late result', async () => {
		let finish!: (value: ResonitePackageInfo) => void;
		mocks.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		const view = create();
		await fireEvent.click(view.getByRole('button', { name: 'Show contents' }));
		const signal = mocks.api.mock.calls[0][3] as AbortSignal;
		view.unmount(); wrapper = undefined;
		expect(signal.aborted).toBe(true);
		finish(info);
		await flush();
		expect(view.container.childElementCount).toBe(0);
	});
	test('never queries metadata for ephemeral media', () => {
		const view = create(makeFile(), { ephemeral: true });
		expect(view.queryByRole('button', { name: 'Show contents' })).toBeNull();
		expect(view.getByRole('link', { name: 'Download' })).toBeTruthy();
		expect(mocks.api).not.toHaveBeenCalled();
	});
	test('preserves authorized blob downloads for ephemeral attachments only', async () => {
		const media = makeFile({ url: 'blob:https://misskey.example/authorized-attachment' });
		const view = create(media, { ephemeral: true });
		expect(view.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(media.url);
		await view.rerender({ ephemeral: false });
		expect(view.queryByRole('link', { name: 'Download' })).toBeNull();
	});
	test('does not offer local analysis for synthesized peer attachments in direct mode', () => {
		const view = create(makeFile({ id: 'gridspace:peer:file' }), { disableAnalysis: true });
		expect(view.queryByRole('button', { name: 'Show contents' })).toBeNull();
		expect(view.getByRole('link', { name: 'Download' })).toBeTruthy();
		expect(mocks.api).not.toHaveBeenCalled();
	});
	test('requires note context to inspect another user’s file', async () => {
		const view = create(makeFile({ userId: 'other-user' }));
		expect(view.queryByRole('button', { name: 'Show contents' })).toBeNull();
		await view.rerender({ noteId: 'visible-note' });
		expect(view.getByRole('button', { name: 'Show contents' })).toBeTruthy();
	});
	test('can display preloaded metadata for ephemeral media without an API call', () => {
		const view = create(makeFile({ properties: { resonitePackage: info } }), { ephemeral: true });
		expect(view.getByText('Misskey Client')).toBeTruthy();
		expect(mocks.api).not.toHaveBeenCalled();
	});
});
