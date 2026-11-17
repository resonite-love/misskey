/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import type { entities } from 'misskey-js';
import type { IPaginator } from '@/utility/paginator.js';
import type { TimelineDisplayRow } from '@/utility/timeline-client.js';
import { TimelineClient } from '@/utility/timeline-client.js';
import { useLegacyGridspaceHome } from '@/utility/use-legacy-gridspace-home.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { supportsTimelineKind } from '@/utility/timeline-capabilities.js';
import { subscribeTimeline } from '@/utility/timeline-stream.js';

/** The legacy reader remains isolated until both servers advertise the new contract. */
export function useGridspaceHome(normal: IPaginator<entities.Note>, params: ComputedRef<entities.GridspacePrivateNotesRequest | null>, isTop: () => boolean, withSensitive: ComputedRef<boolean>, kind: ComputedRef<'home' | 'social'> = computed(() => 'home'), view: { anchor?: () => string | undefined; beforeReplace?: () => void; afterReplace?: () => void; onNewItems?: (items: TimelineDisplayRow[]) => void; prepareNote?: (note: entities.Note) => entities.Note; isPaused?: () => boolean } = {}) {
	const integrated = ref(false);
	const deciding = ref(true);
	const legacyAllowed = ref(false);
	const client = shallowRef<TimelineClient | null>(null);
	const legacy = useLegacyGridspaceHome(normal, computed(() => legacyAllowed.value ? params.value : null), isTop, withSensitive);
	let generation = 0;
	let active = true;
	const rows = computed<TimelineDisplayRow[]>(() => integrated.value ? client.value?.rows.value ?? [] : legacy.rows.value.map(row => ({ ...row, leased: row.kind === 'private' })));
	const busy = computed(() => deciding.value || (integrated.value ? client.value?.busy.value ?? false : legacy.busy.value));
	const initialLoading = computed(() => deciding.value || (integrated.value ? client.value?.loading.value ?? false : normal.fetching.value));
	const initialError = computed(() => integrated.value ? (client.value?.failed.value ?? false) && rows.value.length === 0 : normal.error.value);
	const loading = computed(() => integrated.value ? client.value?.busy.value ?? false : legacy.loading.value);
	const error = computed(() => integrated.value ? client.value?.error.value ?? false : legacy.error.value);
	const hasMore = computed(() => integrated.value ? client.value?.hasMore.value ?? false : legacy.hasMore.value);
	const queuedCount = computed(() => integrated.value ? client.value?.queuedCount.value ?? 0 : legacy.queuedCount.value);
	const pagingKey = computed(() => integrated.value ? client.value?.pagingKey.value ?? 0 : legacy.pagingKey.value);

	async function select() {
		const current = ++generation;
		client.value?.dispose(); client.value = null;
		legacyAllowed.value = false; integrated.value = false; deciding.value = true;
		if (params.value) {
			try {
				const status = await misskeyApi('gridspace/link', { action: 'status' });
				if (current !== generation) return;
				if (supportsTimelineKind(status, kind.value)) {
					integrated.value = true;
					const { mode: _mode, ...filters } = params.value;
					client.value = new TimelineClient({ ...filters, kind: kind.value }, { ...view, subscribe: subscribeTimeline, isTop, withSensitive: () => withSensitive.value });
					if (active) await client.value.reload();
					if (current === generation) deciding.value = false;
					return;
				}
			} catch { /* Older servers retain the existing reader. */ }
		}
		if (current !== generation) return;
		legacyAllowed.value = true; deciding.value = false;
		await normal.init();
	}

	async function reload() {
		if (integrated.value) await client.value?.reload();
		else await Promise.all([normal.reload(), legacy.reload()]);
	}

	async function refresh() { if (integrated.value) await client.value?.refresh(); }

	function visibility() {
		if (!integrated.value) return;
		if (window.document.hidden) client.value?.suspend();
		else if (active) void client.value?.resume();
	}

	function focus() { if (active && integrated.value && !window.document.hidden) void client.value?.resume(); }

	window.document.addEventListener('visibilitychange', visibility);
	window.addEventListener('focus', focus);
	watch(() => JSON.stringify([params.value, kind.value]), select, { immediate: true });
	onDeactivated(() => { active = false; client.value?.suspend(); });
	onActivated(() => { if (!active) { active = true; focus(); } });
	onBeforeUnmount(() => {
		generation++; active = false; client.value?.dispose();
		window.document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
	});
	return {
		rows, hasMore, loading, initialLoading, initialError, busy, queuedCount, pagingKey, error, integrated, deciding,
		reload, refresh,
		fetchOlder: () => integrated.value ? client.value?.load() : legacy.fetchOlder(),
		releaseQueue: () => integrated.value ? client.value?.releaseQueue() : legacy.releaseQueue(),
		fail: () => integrated.value ? client.value?.fail() : legacy.fail(),
		removeNormal: (id: string) => { normal.removeItem(id); client.value?.removeNormal(id); },
	};
}
