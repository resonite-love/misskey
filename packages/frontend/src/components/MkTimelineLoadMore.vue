<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="hasMore && !loading && !disabled" ref="sentinel" :class="[$style.sentinel, { [$style.manual]: !prefer.s.enableInfiniteScroll }]" data-timeline-load-more>
	<MkButton v-if="!prefer.s.enableInfiniteScroll" @click="requestLoad">{{ i18n.ts.loadMore }}</MkButton>
</div>
</template>

<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, ref, useTemplateRef, watch } from 'vue';
import MkButton from '@/components/MkButton.vue';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';
import { useDocumentVisibility } from '@@/js/use-document-visibility.js';

const props = withDefaults(defineProps<{ hasMore: boolean; loading: boolean; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ (event: 'load'): void }>();
const sentinel = useTemplateRef('sentinel');
const active = ref(true);
const visibility = useDocumentVisibility();
let observer: IntersectionObserver | undefined;

function requestLoad() {
	if (!props.hasMore || props.loading || props.disabled || !active.value || visibility.value !== 'visible') return;
	emit('load');
}

watch([sentinel, prefer.r.enableInfiniteScroll, active, visibility], ([element, automatic, isActive, state]) => {
	observer?.disconnect();
	if (!element || !automatic || !isActive || state !== 'visible') return;
	const current = new IntersectionObserver(entries => {
		if (observer === current && prefer.s.enableInfiniteScroll && element === sentinel.value && entries.some(entry => entry.isIntersecting)) requestLoad();
	}, { rootMargin: '200px' });
	observer = current;
	observer.observe(element);
});

onDeactivated(() => { active.value = false; });
onActivated(() => { active.value = true; });
onBeforeUnmount(() => { active.value = false; observer?.disconnect(); });
</script>

<style lang="scss" module>
.sentinel { min-height: 1px; }
.manual { padding: 16px; }
</style>
