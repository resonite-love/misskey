<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="root" :data-gridspace-private-row="row.leased ? '' : undefined" :aria-busy="suspended" :style="{ height: suspended ? `${height}px` : undefined, minHeight: height ? `${height}px` : undefined }" @pointerdown="releaseHeight" @keydown="releaseHeight">
	<div v-if="suspended" :class="$style.placeholder" aria-hidden="true"></div>
	<MkGridspacePrivateNote v-else-if="row.kind === 'private'" :key="bodyKey" v-model:expanded="expanded" :note="row.note as GridspacePrivateNote" @unavailable="emit('unavailable')" @replied="emit('replied')"/>
	<MkNote v-else-if="row.kind === 'normal'" :key="bodyKey" v-model:expanded="expanded" :note="row.note" :withHardMute="true"/>
</div>
</template>

<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';
import type { GridspacePrivateNote } from '@/utility/gridspace-note-suspension.js';
import type { TimelineDisplayRow } from '@/utility/timeline-client.js';
import { timelineNoteContent } from '@/utility/timeline-note-content.js';
import MkGridspacePrivateNote from '@/components/MkGridspacePrivateNote.vue';
import MkNote from '@/components/MkNote.vue';

const props = defineProps<{ row: TimelineDisplayRow }>();
const emit = defineEmits<{ (event: 'unavailable'): void; (event: 'replied'): void }>();
const root = useTemplateRef('root');
const height = ref(0);
const expanded = ref(false);
const bodyKey = ref(0);
const suspended = computed(() => props.row.kind === 'placeholder' || (props.row.kind === 'private' && 'suspended' in props.row.note));
// Note cards keep display copies. Replace those copies if reauthorization changes
// the body, while the wrapper retains the user's CW choice and measured height.
watch(() => props.row, (row, previous) => {
	if (row.kind !== previous.kind || (row.kind !== 'placeholder' && previous.kind !== 'placeholder' && timelineNoteContent(row.note) !== timelineNoteContent(previous.note))) bodyKey.value++;
}, { flush: 'pre' });

function releaseHeight() { if (!suspended.value) height.value = 0; }

watch(suspended, value => {
	if (value && root.value) height.value = root.value.getBoundingClientRect().height;
}, { flush: 'pre' });
</script>

<style lang="scss" module>
.placeholder {
	height: 100%;
	background: var(--MI_THEME-panelHighlight);
}
</style>
