/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { computed, createApp, nextTick } from 'vue';
import type { entities } from 'misskey-js';
import { mergeHomeRows } from '@/utility/gridspace-home-merge.js';
import { Paginator } from '@/utility/paginator.js';
import { useGridspaceHome } from '@/utility/use-gridspace-home.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { hardMutedWords: [] } }));
const api = vi.mocked(misskeyApi);
const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const normal = (n: number, uri?: string) => ({ id: `n${n}`, createdAt: at(n), uri });
const privateNote = (n: number) => ({ id: `p${n}`, uri: `https://peer/notes/p${n}`, createdAt: at(n), text: `private ${n}`, files: [] });
const page = (notes: unknown[] = [], cursor: string | null = null, scannedThrough: string | null = null) => ({ notes, cursor, scannedThrough, observedAt: at(100) });
const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); await nextTick(); };
let cleanup = () => {};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(at(100))); api.mockReset(); });
afterEach(() => { cleanup(); cleanup = () => {}; vi.useRealTimers(); });

describe('home common timeline', () => {
	it('holds equal-time and older rows until both streams have scanned them', () => {
		const n = [normal(5), normal(2)]; const p = [privateNote(4), privateNote(2), privateNote(1)];
		expect(mergeHomeRows(n, p, 'https://local', Date.parse(at(2)), Date.parse(at(1))).map(row => row.createdAt)).toEqual([at(5), at(4)]);
		expect(mergeHomeRows(n, p, 'https://local', -Infinity, -Infinity)).toHaveLength(5);
	});
	it('deduplicates by canonical URI, preferring readable normal notes but not hidden shells', () => {
		const p = privateNote(4); const n = { ...normal(4, p.uri), url: 'https://unrelated' };
		expect(mergeHomeRows([n], [p], 'https://local', -Infinity, -Infinity).map(row => row.kind)).toEqual(['normal']);
		expect(mergeHomeRows([{ ...n, isHidden: true }], [p], 'https://local', -Infinity, -Infinity).map(row => row.kind)).toEqual(['private']);
		expect(mergeHomeRows([{ ...normal(4), url: p.uri }], [p], 'https://local', -Infinity, -Infinity)).toHaveLength(2);
	});
	it('preserves initial errors and retries an older page without declaring history exhausted', async () => {
		const paginator = new Paginator('notes/timeline', {});
		api.mockRejectedValueOnce(new Error('offline'));
		await paginator.init();
		expect(paginator.error.value).toBe(true);
		paginator.items.value = [normal(10)] as entities.Note[];
		paginator.canFetchOlder.value = true;
		api.mockRejectedValueOnce(new Error('offline'));
		await paginator.fetchOlder();
		expect(paginator.canFetchOlder.value).toBe(true);
		expect(paginator.items.value.map(note => note.id)).toEqual(['n10']);
		expect(paginator.fetchingOlder.value).toBe(false);
		api.mockResolvedValueOnce([]);
		await paginator.fetchOlder();
		expect(paginator.canFetchOlder.value).toBe(false);
	});
});

function mountHome(isTop = () => false, delegated = true) {
	const paginator = new Paginator('notes/timeline', {});
	paginator.fetching.value = false; paginator.canFetchOlder.value = false;
	let home!: ReturnType<typeof useGridspaceHome>;
	const app = createApp({ setup() { home = useGridspaceHome(paginator, computed(() => delegated ? { mode: 'home' } : null), isTop, computed(() => true)); return () => null; } });
	app.mount(document.createElement('div'));
	cleanup = () => app.unmount();
	return { home, paginator };
}

describe('private home lifecycle', () => {
	it('preserves rows and old cursor, reauthorizes without a head reset, and ignores stale validation', async () => {
		api.mockResolvedValueOnce({ available: true, granted: true }).mockResolvedValueOnce(page([privateNote(8)], 'old-cursor', at(4)));
		const { home, paginator } = mountHome(); await settle();
		const native = normal(9) as entities.Note; paginator.items.value = [native];
		const original = home.rows.value[0].note;
		const keys = home.rows.value.map(row => row.key);
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(home.rows.value.map(row => row.key)).toEqual(keys);
		expect(home.rows.value[0].note).toBe(original);
		expect(home.rows.value[1].note).toEqual({ id: 'p8', uri: privateNote(8).uri, createdAt: at(8), suspended: true, visible: true });
		let stale!: (value: unknown) => void;
		api.mockImplementationOnce(() => new Promise(resolve => { stale = resolve; }));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); await settle();
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'validate', ids: ['p8'] });
		expect(api).toHaveBeenCalledTimes(3);
		hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
		stale(page([privateNote(8)])); await settle();
		expect(home.rows.value[1].note).toHaveProperty('suspended', true);
		api.mockResolvedValueOnce(page([privateNote(8)])).mockResolvedValueOnce(page());
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(home.rows.value[1].note).toHaveProperty('text', 'private 8');
		api.mockResolvedValueOnce(page([privateNote(2)])); await home.fetchOlder();
		expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'old-cursor' });
		vi.restoreAllMocks();
	});
	it('keeps normal pagination usable on non-home timelines after a tab switch', async () => {
		const { home, paginator } = mountHome(() => false, false); await settle();
		paginator.canFetchOlder.value = true;
		const fetch = vi.spyOn(paginator, 'fetchOlder').mockResolvedValue(undefined);
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
		await home.fetchOlder(); expect(fetch).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
	it('removes denied suspended notes and retains normal pagination after a peer failure', async () => {
		api.mockResolvedValueOnce({ available: true, granted: true }).mockResolvedValueOnce(page([privateNote(8)]));
		const { home, paginator } = mountHome(); await settle();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		api.mockRejectedValueOnce(new Error('revoked'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(home.error.value).toBe(true); expect(home.rows.value).toHaveLength(0);
		hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
		const fetch = vi.spyOn(paginator, 'fetchOlder').mockResolvedValue(undefined);
		await home.fetchOlder(); expect(fetch).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
	it('keeps native rows when private retrieval fails and clears queued bodies', async () => {
		api.mockResolvedValueOnce({ available: true, granted: true }).mockResolvedValueOnce(page([privateNote(1)]));
		const { home, paginator } = mountHome();
		paginator.items.value = [normal(2)] as entities.Note[];
		await settle();
		expect(home.rows.value.map(row => row.kind)).toEqual(['normal', 'private']);
		api.mockRejectedValueOnce(new Error('revoked'));
		await vi.advanceTimersByTimeAsync(10000);
		expect(home.error.value).toBe(true);
		expect(home.rows.value.map(row => row.kind)).toEqual(['normal']);
		expect(home.queuedCount.value).toBe(0);
	});
	it('finishes all pages of a new-note window, queues them, and revalidates the queue', async () => {
		api.mockResolvedValueOnce({ available: true, granted: true }).mockResolvedValueOnce(page());
		const { home } = mountHome(); await settle();
		vi.setSystemTime(new Date(at(160))); // Client clock must not define the source window.
		const notes = Array.from({ length: 25 }, (_, n) => privateNote(101 + n));
		api.mockResolvedValueOnce(page(notes.slice(5), 'next', at(106))).mockResolvedValueOnce(page(notes.slice(0, 5)));
		await vi.advanceTimersByTimeAsync(10000);
		expect(api.mock.calls[2][1]).toMatchObject({ rangeStartAt: Date.parse(at(100)) - 1001 });
		expect(home.queuedCount.value).toBe(25);
		expect(home.rows.value).toHaveLength(0);
		// The source removes a queued note before the user releases the queue.
		api.mockResolvedValueOnce(page(notes.slice(1))).mockResolvedValueOnce(page());
		await vi.advanceTimersByTimeAsync(10000);
		expect(home.queuedCount.value).toBe(24);
		home.releaseQueue();
		expect(home.rows.value).toHaveLength(24);
		expect(home.rows.value.some(row => row.note.id === 'p101')).toBe(false);
	});
	it('rearms infinite scroll when a filtered equal-time page only advances the cursor', async () => {
		api.mockResolvedValueOnce({ available: true, granted: true }).mockResolvedValueOnce(page([], 'first', at(2)));
		const { home } = mountHome(); await settle();
		api.mockResolvedValueOnce(page([], 'second', at(2)));
		await home.fetchOlder();
		expect(home.rows.value).toHaveLength(0);
		expect(home.pagingKey.value).toBe(1);
		api.mockRejectedValueOnce(new Error('offline'));
		await home.fetchOlder();
		expect(home.error.value).toBe(true);
		expect(home.hasMore.value).toBe(false);
	});
	it('does not resurrect an in-flight body after hiding the tab', async () => {
		let answer!: (value: unknown) => void;
		api.mockResolvedValueOnce({ available: true, granted: true }).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
		const { home } = mountHome(); await settle();
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		answer(page([privateNote(1)])); await settle();
		expect(home.rows.value).toHaveLength(0);
		vi.restoreAllMocks();
	});
	it('rearms when the normal stream advances through the same timestamp', async () => {
		api.mockResolvedValueOnce({ available: true, granted: true }).mockResolvedValueOnce(page());
		const { home, paginator } = mountHome(); await settle();
		paginator.items.value = [normal(2)] as entities.Note[];
		paginator.canFetchOlder.value = true;
		vi.spyOn(paginator, 'fetchOlder').mockImplementation(async () => { paginator.items.value.push({ ...normal(2), id: 'older' } as entities.Note); });
		await home.fetchOlder();
		expect(home.rows.value).toHaveLength(0);
		expect(home.pagingKey.value).toBe(1);
	});
});
