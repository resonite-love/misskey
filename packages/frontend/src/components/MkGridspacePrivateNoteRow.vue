<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="root" :class="$style.root" data-gridspace-private-row :aria-busy="suspended" :style="{ height: suspended ? `${height}px` : undefined, minHeight: height ? `${height}px` : undefined }" @pointerdown="releaseHeight" @keydown="releaseHeight">
	<div v-if="suspended" :class="$style.placeholder" aria-hidden="true"></div>
	<MkGridspacePrivateNote v-else v-model:expanded="expanded" :note="note as GridspacePrivateNote" @unavailable="emit('unavailable')" @replied="emit('replied')"/>
</div>
</template>

<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';
import type { GridspaceNoteEntry, GridspacePrivateNote } from '@/utility/gridspace-note-suspension.js';
import MkGridspacePrivateNote from '@/components/MkGridspacePrivateNote.vue';
import { isSuspendedNote } from '@/utility/gridspace-note-suspension.js';

const props = defineProps<{ note: GridspaceNoteEntry }>();
const emit = defineEmits<{ (event: 'unavailable'): void; (event: 'replied'): void }>();
const root = useTemplateRef('root');
const height = ref(0);
const expanded = ref(false);
const suspended = computed(() => isSuspendedNote(props.note));

// Reopened media may need another authorized fetch. Keep the previous footprint
// until the reader explicitly interacts with the restored row.
function releaseHeight() { if (!suspended.value) height.value = 0; }

// Before Vue removes the body/media, preserve the actual layout of this row.
watch(suspended, value => {
	if (value && root.value) height.value = root.value.getBoundingClientRect().height;
}, { flush: 'pre' });
</script>

<style lang="scss" module>
.root { box-sizing: border-box; }
.placeholder {
	height: 100%;
	background: var(--MI_THEME-panelHighlight);
}
</style>
