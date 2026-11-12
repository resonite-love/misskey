<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" :refresher="reload">
<div :class="$style.root" :aria-busy="loading" data-gridspace-note-list>
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
	<div v-if="hasMore && !loading" :key="pagingKey" ref="sentinel" :class="$style.status">
		<MkButton @click="load">{{ i18n.ts.loadMore }}</MkButton>
	</div>
</div>
</component>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, useTemplateRef, watch } from 'vue';
import MkNote from '@/components/MkNote.vue';
import MkGridspacePrivateNoteRow from '@/components/MkGridspacePrivateNoteRow.vue';
import MkButton from '@/components/MkButton.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { useGridspaceNoteList } from '@/utility/use-gridspace-note-list.js';
import type { GridspaceNoteSource } from '@/utility/use-gridspace-note-list.js';
import { useGlobalEvent } from '@/events.js';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{ source: GridspaceNoteSource }>();
const emit = defineEmits<{ (event: 'unavailable'): void }>();
const { rows, loading, hasMore, normalError, privateError, needsAuthorization, pagingKey, load, reload, retry, failPrivate, removeNormal } = useGridspaceNoteList(computed(() => props.source));
const sentinel = useTemplateRef('sentinel');
let observer: IntersectionObserver | undefined;
watch([sentinel, prefer.r.enableInfiniteScroll], ([element, enabled]) => {
	observer?.disconnect();
	if (!element || !enabled) return;
	observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(); }, { rootMargin: '200px' });
	observer.observe(element);
});
watch(normalError, value => { if (value === 'LINK_UNAVAILABLE') emit('unavailable'); });
useGlobalEvent('noteDeleted', removeNormal);
onBeforeUnmount(() => observer?.disconnect());
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
