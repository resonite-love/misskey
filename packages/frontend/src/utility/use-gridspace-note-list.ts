/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import { note as noteUtils } from 'misskey-js';
import type { ComputedRef } from 'vue';
import type { GridspaceNoteSource } from '@/utility/use-legacy-gridspace-note-list.js';
import type { TimelineDisplayRow, TimelineQuery } from '@/utility/timeline-client.js';
import { useLegacyGridspaceNoteList } from '@/utility/use-legacy-gridspace-note-list.js';
import { TimelineClient } from '@/utility/timeline-client.js';
import { supportsTimelineKind } from '@/utility/timeline-capabilities.js';
import { subscribeTimeline } from '@/utility/timeline-stream.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { checkNoteWordMute } from '@/composables/use-note.js';
import { $i } from '@/i.js';

export type { GridspaceNoteSource } from '@/utility/use-legacy-gridspace-note-list.js';

export function gridspaceListQuery(source: GridspaceNoteSource): TimelineQuery {
	if (source.kind === 'mentions') return { kind: source.direct ? 'direct' : 'mentions' };
	if (source.kind === 'profile') { const { linked: _linked, ...query } = source; return query; }
	return { ...source };
}

/** Select one reader before loading; an unavailable unified feed never mixes legacy cursors. */
export function useGridspaceNoteList(source: ComputedRef<GridspaceNoteSource>) {
	const integrated = ref(false);
	const deciding = ref(true);
	const legacyAllowed = ref(false);
	const client = shallowRef<TimelineClient | null>(null);
	const legacy = useLegacyGridspaceNoteList(source, computed(() => legacyAllowed.value));
	let generation = 0;
	let active = true;
	const rows = computed<TimelineDisplayRow[]>(() => {
		if (!integrated.value) return legacy.rows.value.map(row => ({ ...row, leased: row.kind === 'private' }));
		return (client.value?.rows.value ?? []).filter(row => row.kind !== 'normal' || !$i || !checkNoteWordMute(noteUtils.isPureRenote(row.note) ? row.note.renote ?? row.note : row.note, $i, $i.hardMutedWords));
	});
	const loading = computed(() => deciding.value || (integrated.value ? client.value?.busy.value ?? false : legacy.loading.value));
	const hasMore = computed(() => integrated.value ? client.value?.hasMore.value ?? false : legacy.hasMore.value);
	const normalError = computed(() => integrated.value ? client.value?.sources.value.some(state => state.source === 'local' && state.status === 'unavailable') ? 'UNAVAILABLE' : null : legacy.normalError.value);
	const privateError = computed(() => integrated.value ? (client.value?.error.value ?? false) || (client.value?.sources.value.some(state => state.source === 'peer' && state.status === 'unavailable') ?? false) : legacy.privateError.value);
	const needsAuthorization = computed(() => integrated.value ? client.value?.needsAuthorization.value ?? false : legacy.needsAuthorization.value);
	const pagingKey = computed(() => integrated.value ? client.value?.pagingKey.value ?? 0 : legacy.pagingKey.value);

	async function select() {
		const current = ++generation;
		client.value?.dispose(); client.value = null;
		legacyAllowed.value = false; integrated.value = false; deciding.value = true;
		if ($i) {
			try {
				const query = gridspaceListQuery(source.value);
				const status = await misskeyApi('gridspace/link', { action: 'status' });
				if (current !== generation) return;
				if (supportsTimelineKind(status, query.kind)) {
					integrated.value = true;
					client.value = new TimelineClient(query, { subscribe: subscribeTimeline });
					if (active) await client.value.reload();
					if (current === generation) deciding.value = false;
					return;
				}
			} catch { /* Unknown capability uses the established reader. */ }
		}
		if (current !== generation) return;
		legacyAllowed.value = true; deciding.value = false;
	}

	function visibility() {
		if (!integrated.value) return;
		if (window.document.hidden) client.value?.suspend(); else if (active) void client.value?.resume();
	}

	function focus() { if (active && integrated.value && !window.document.hidden) void client.value?.resume(); }

	window.document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus);
	watch(() => JSON.stringify(source.value), select, { immediate: true });
	onDeactivated(() => { active = false; client.value?.suspend(); });
	onActivated(() => { if (!active) { active = true; focus(); } });
	onBeforeUnmount(() => {
		generation++; active = false; client.value?.dispose();
		window.document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
	});
	return {
		rows, loading, hasMore, normalError, privateError, needsAuthorization, pagingKey, integrated,
		load: () => integrated.value ? client.value?.load() : legacy.load(),
		reload: () => integrated.value ? client.value?.reload() : legacy.reload(),
		retry: () => integrated.value ? client.value?.retry() : legacy.retry(),
		failPrivate: () => integrated.value ? client.value?.fail() : legacy.failPrivate(),
		removeNormal: (id: string) => { client.value?.removeNormal(id); legacy.removeNormal(id); },
		removePrivate: (id: string) => { client.value?.removePrivate(id); legacy.removePrivate(id); },
	};
}
