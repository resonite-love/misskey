<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl">
	<div v-if="translated && !showOriginal && result?.cw" :class="$style.cw">
		<Mfm :text="result.cw" :author="note.user" :emojiUrls="note.emojis" :nyaize="'respect'"/>
	</div>
	<slot :text="displayText" :translated="translated && !showOriginal"></slot>
	<div v-if="translated" :class="$style.status">
		<span>{{ i18n.ts._autoTranslation.translated }}</span>
		<button class="_textButton" type="button" :aria-pressed="showOriginal" @click.stop="showOriginal = !showOriginal">{{ showOriginal ? i18n.ts._autoTranslation.showTranslation : i18n.ts._autoTranslation.showOriginal }}</button>
	</div>
	<div v-else-if="failed" :class="$style.status">
		<span>{{ i18n.ts._autoTranslation.failed }}</span>
		<button class="_textButton" type="button" @click.stop="retry++">{{ i18n.ts.retry }}</button>
	</div>
</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { getAutoTranslationCapabilities, requestAutoTranslation } from '@/utility/auto-translation.js';
import type { TranslationResult } from '@/utility/auto-translation.js';

const props = withDefaults(defineProps<{
	note: entities.Note;
	active?: boolean;
}>(), { active: true });
defineSlots<{ default(props: { text: string | null; translated: boolean }): unknown }>();

const rootEl = ref<HTMLElement>();
const intersecting = ref(false);
const result = ref<TranslationResult>();
const showOriginal = ref(false);
const failed = ref(false);
const retry = ref(0);
const enabled = prefer.r['autoTranslation.enabled'];
const targetLang = prefer.r['autoTranslation.targetLang'];
let observer: IntersectionObserver | undefined;
let generation = 0;
const translated = computed(() => {
	const value = result.value;
	if (value?.status !== 'translated') return false;
	const normalize = (text: string | null | undefined) => (text ?? '').replace(/\r\n?/g, '\n').trim().normalize('NFC');
	return normalize(value.text ?? props.note.text) !== normalize(props.note.text) ||
		normalize(value.cw ?? props.note.cw) !== normalize(props.note.cw);
});
const displayText = computed(() => translated.value && !showOriginal.value ? result.value?.text ?? props.note.text : props.note.text);

onMounted(() => {
	observer = new IntersectionObserver(entries => { intersecting.value = entries.some(entry => entry.isIntersecting); });
	if (rootEl.value) observer.observe(rootEl.value);
});
onBeforeUnmount(() => { generation++; observer?.disconnect(); });

watch(() => [props.note.id, props.note.text, props.note.cw, props.note.isHidden, props.note.deletedAt,
	props.active, intersecting.value, enabled.value, targetLang.value, $i?.id, retry.value], async () => {
	const current = ++generation;
	result.value = undefined;
	showOriginal.value = false;
	failed.value = false;
	if (!props.active || !intersecting.value || !enabled.value || !$i || props.note.isHidden || props.note.deletedAt || (!props.note.text && !props.note.cw)) return;
	const isCurrent = () => current === generation;
	try {
		const capability = await getAutoTranslationCapabilities();
		if (!isCurrent() || !capability.available) return;
		const translation = await requestAutoTranslation(props.note, targetLang.value, isCurrent);
		if (isCurrent()) result.value = translation;
	} catch {
		if (isCurrent()) failed.value = true;
	}
}, { immediate: true });
</script>

<style lang="scss" module>
.status {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 6px;
	color: var(--MI_THEME-fgTransparentWeak);
	font-size: 0.8em;
}

.cw {
	margin-bottom: 8px;
	font-weight: bold;
}
</style>
