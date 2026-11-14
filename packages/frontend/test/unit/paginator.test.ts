/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { entities } from 'misskey-js';
import { Paginator } from '@/utility/paginator.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));

function note(id: string): entities.Note {
	return { id, createdAt: '2026-11-14T00:00:00.000Z' } as entities.Note;
}

async function createPaginator() {
	const paginator = new Paginator('notes/timeline', { useShallowRef: true });
	await paginator.init();
	vi.mocked(misskeyApi).mockClear();
	return paginator;
}

describe('Paginator duplicate notes', () => {
	beforeEach(() => {
		vi.mocked(misskeyApi).mockReset();
		vi.mocked(misskeyApi).mockResolvedValue([]);
	});

	test('deduplicates repeated streaming events before releasing the queue', async () => {
		const paginator = await createPaginator();
		paginator.enqueue(note('01'));
		paginator.enqueue(note('01'));
		paginator.enqueue(note('02'));
		expect(paginator.queuedAheadItemsCount.value).toBe(2);
		paginator.releaseQueue();
		expect(paginator.items.value.map(item => item.id)).toEqual(['02', '01']);
	});

	test('does not queue a note already displayed', async () => {
		const paginator = await createPaginator();
		paginator.prepend(note('01'));
		paginator.enqueue(note('01'));
		expect(paginator.queuedAheadItemsCount.value).toBe(0);
	});

	test('deduplicates within a prepended batch as well as against displayed notes', async () => {
		const paginator = await createPaginator();
		paginator.prepend(note('01'));
		paginator.unshiftItems([note('03'), note('03'), note('02'), note('01')]);
		expect(paginator.items.value.map(item => item.id)).toEqual(['03', '02', '01']);
	});

	test('deduplicates overlapping older pages and duplicate entries in one page', async () => {
		const paginator = await createPaginator();
		paginator.pushItems([note('03'), note('02')]);
		paginator.pushItems([note('02'), note('01'), note('01')]);
		expect(paginator.items.value.map(item => item.id)).toEqual(['03', '02', '01']);
	});

	test('deduplicates overlapping polling results while notes wait in the queue', async () => {
		const paginator = await createPaginator();
		paginator.prepend(note('01'));
		paginator.enqueue(note('02'));
		vi.mocked(misskeyApi).mockResolvedValueOnce([note('02'), note('03'), note('03')]);
		await paginator.fetchNewer({ toQueue: true });
		expect(paginator.queuedAheadItemsCount.value).toBe(2);
		paginator.releaseQueue();
		expect(paginator.items.value.map(item => item.id)).toEqual(['03', '02', '01']);
	});

	test('does not run simultaneous newer fetches', async () => {
		const paginator = await createPaginator();
		paginator.prepend(note('01'));
		let resolve!: (notes: entities.Note[]) => void;
		vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise<entities.Note[]>(done => { resolve = done; }));
		const first = paginator.fetchNewer({ toQueue: true });
		const second = paginator.fetchNewer({ toQueue: true });
		resolve([]);
		await Promise.all([first, second]);
		expect(misskeyApi).toHaveBeenCalledTimes(1);
		expect(paginator.fetchingNewer.value).toBe(false);
	});

	test.each(['05', '06'])('preserves newest-first order when streaming %s arrives during polling', async streamedId => {
		const paginator = await createPaginator();
		paginator.prepend(note('01'));
		let resolve!: (notes: entities.Note[]) => void;
		vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise<entities.Note[]>(done => { resolve = done; }));
		const pending = paginator.fetchNewer({ toQueue: true });
		paginator.enqueue(note(streamedId));
		resolve(['02', '03', '04', '05'].map(note));
		await pending;
		paginator.releaseQueue();
		expect(paginator.items.value.map(item => item.id)).toEqual(streamedId === '05' ? ['05', '04', '03', '02', '01'] : ['06', '05', '04', '03', '02', '01']);
	});

	test('keeps the queued note metadata when an in-flight poll returns the same note', async () => {
		const paginator = await createPaginator();
		paginator.prepend(note('01'));
		let resolve!: (notes: entities.Note[]) => void;
		vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise<entities.Note[]>(done => { resolve = done; }));
		const pending = paginator.fetchNewer({ toQueue: true });
		const streamed = { ...note('02'), _shouldInsertAd_: true };
		paginator.enqueue(streamed);
		resolve([note('02')]);
		await pending;
		paginator.releaseQueue();
		expect(paginator.items.value[0]).toBe(streamed);
		expect(paginator.items.value[0]._shouldInsertAd_).toBe(true);
	});

	test('does not evict newer streaming notes when an older in-flight poll fills the queue', async () => {
		const paginator = await createPaginator();
		paginator.prepend(note('000'));
		let resolve!: (notes: entities.Note[]) => void;
		vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise<entities.Note[]>(done => { resolve = done; }));
		const pending = paginator.fetchNewer({ toQueue: true });
		for (let id = 6; id <= 110; id++) paginator.enqueue(note(String(id).padStart(3, '0')));
		resolve(['001', '002', '003', '004', '005'].map(note));
		await pending;
		expect(paginator.queuedAheadItemsCount.value).toBe(100);
		paginator.releaseQueue();
		expect(paginator.items.value[0].id).toBe('110');
		expect(paginator.items.value.at(-1)?.id).toBe('081');
	});
});
