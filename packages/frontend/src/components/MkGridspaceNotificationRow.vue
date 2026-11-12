<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="root" :data-gridspace-peer-notification="row.source === 'peer' ? '' : undefined" :style="height ? { minHeight: `${height}px`, boxSizing: 'border-box' } : undefined" @pointerdown="releaseHeight" @keydown="releaseHeight">
	<div v-if="row.suspended" :style="{ height: `${height}px` }" aria-busy="true"></div>
	<slot v-else></slot>
</div>
</template>

<script setup lang="ts">
import { ref, useTemplateRef, watch, onMounted, onBeforeUnmount } from 'vue';
import type { NotificationGroup } from '@/utility/use-gridspace-notifications.js';
const props = defineProps<{ row: NotificationGroup }>();
const emit = defineEmits<{ seen: [row: NotificationGroup] }>();
const root = useTemplateRef('root');
let visible = false;
let observer: IntersectionObserver | undefined;

function seen() { if (visible && !props.row.suspended) emit('seen', props.row); }

onMounted(() => {
	observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); seen(); });
	if (root.value) observer.observe(root.value);
});
watch(() => props.row, seen, { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());
const height = ref(0);

function releaseHeight() { if (!props.row.suspended) height.value = 0; }

watch(() => props.row.suspended, suspended => { if (suspended && root.value) height.value = root.value.getBoundingClientRect().height; }, { flush: 'pre' });
</script>
