<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" :refresher="reload">
	<div :class="$style.root" :aria-busy="loading" data-gridspace-note-list>
		<MkPaginationControl v-if="withControl" :paginator="control"/>
		<div v-for="row in rows" :key="row.key" :class="$style.entry" :data-scroll-anchor="row.key">
			<MkNote v-if="row.kind === 'normal'" :note="row.note" :withHardMute="true"/>
			<MkGridspacePrivateNoteRow v-else :note="row.note" @unavailable="failPrivate"/>
		</div>
		<div v-if="normalError || privateError" role="status" :class="$style.status">
			<p>{{ i18n.ts._gridspace.notesPartial }}</p>
			<MkButton :disabled="loading" @click="retry">{{ i18n.ts.retry }}</MkButton>
		</div>
		<MkA v-if="needsAuthorization" to="/settings/gridspace" :class="$style.status">{{ i18n.ts._gridspace.collectionsAuthorize }}</MkA>
		<MkLoading v-if="loading"/>
		<p v-else-if="!hasMore && !normalError && !privateError && rows.length === 0" :class="$style.status">{{ i18n.ts.noNotes }}</p>
		<MkTimelineLoadMore :key="pagingKey" :hasMore="hasMore" :loading="loading" @load="load"/>
	</div>
</component>
</template>

<script lang="ts" setup>
import { computed, markRaw, ref, watch } from 'vue';
import type { GridspaceNoteSource } from '@/utility/use-gridspace-note-list.js';
import MkPaginationControl from '@/components/MkPaginationControl.vue';
import MkNote from '@/components/MkNote.vue';
import MkGridspacePrivateNoteRow from '@/components/MkGridspacePrivateNoteRow.vue';
import MkButton from '@/components/MkButton.vue';
import MkTimelineLoadMore from '@/components/MkTimelineLoadMore.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { useGridspaceNoteList } from '@/utility/use-gridspace-note-list.js';
import { useGlobalEvent } from '@/events.js';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{ source: GridspaceNoteSource; withControl?: boolean }>();
const emit = defineEmits<{ (event: 'unavailable'): void }>();
type ClipFilters = Pick<Extract<GridspaceNoteSource, { kind: 'clip' }>, 'order' | 'query' | 'rangeStartAt' | 'rangeEndAt'>;
const filters = ref<ClipFilters>({ order: 'newest' });
const control = markRaw({ order: ref<'newest' | 'oldest'>('newest'), initialDirection: 'older' as 'older' | 'newer', initialDate: null as number | null, canSearch: true, searchQuery: ref<string | null>(null), reload: applyFilters });

async function applyFilters(): Promise<void> {
	const next: ClipFilters = { order: control.order.value, query: control.searchQuery.value?.trim() || undefined, ...(control.order.value === 'oldest' ? { rangeStartAt: control.initialDate ?? undefined } : { rangeEndAt: control.initialDate ?? undefined }) };
	if (JSON.stringify(next) === JSON.stringify(filters.value)) return reload();
	filters.value = next;
}

const source = computed<GridspaceNoteSource>(() => props.source.kind === 'clip' && props.withControl ? { ...props.source, ...filters.value } : props.source);
const { rows, loading, hasMore, normalError, privateError, needsAuthorization, pagingKey, load, reload, retry, failPrivate, removeNormal } = useGridspaceNoteList(source);
watch(normalError, value => { if (value === 'LINK_UNAVAILABLE') emit('unavailable'); });
useGlobalEvent('noteDeleted', removeNormal);
defineExpose({ reload });
</script>

<style lang="scss" module>
.root {
	container-type: inline-size;
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius);
	overflow: clip;
}
.entry { border-bottom: solid 0.5px var(--MI_THEME-divider); }
.status { padding: 20px; }
</style>
