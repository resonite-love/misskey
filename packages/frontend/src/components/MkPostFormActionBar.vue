<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.footerLeft">
	<button class="_button" :class="$style.footerButton" :disabled="!canAttach" :aria-label="i18n.ts.attachFile + ' (' + i18n.ts.upload + ')'" :title="i18n.ts.attachFile + ' (' + i18n.ts.upload + ')'" @click="event => emit('upload', event)"><i class="ti ti-photo-plus"></i></button>
	<button v-if="drive" class="_button" :class="$style.footerButton" :disabled="!canAttach" :aria-label="i18n.ts.attachFile + ' (' + i18n.ts.fromDrive + ')'" :title="i18n.ts.attachFile + ' (' + i18n.ts.fromDrive + ')'" @click="event => emit('drive', event)"><i class="ti ti-cloud-download"></i></button>
	<button class="_button" :class="[$style.footerButton, { [$style.footerButtonActive]: poll }]" :aria-label="i18n.ts.poll" :title="i18n.ts.poll" @click="event => emit('poll', event)"><i class="ti ti-chart-arrows"></i></button>
	<button class="_button" :class="[$style.footerButton, { [$style.footerButtonActive]: useCw }]" :aria-label="i18n.ts.useCw" :title="i18n.ts.useCw" @click="event => emit('cw', event)"><i class="ti ti-eye-off"></i></button>
	<button v-if="showHashtags" class="_button" :class="[$style.footerButton, { [$style.footerButtonActive]: hashtags }]" :aria-label="i18n.ts.hashtags" :title="i18n.ts.hashtags" @click="event => emit('hashtags', event)"><i class="ti ti-hash"></i></button>
	<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.mention" :title="i18n.ts.mention" @click="event => emit('mention', event)"><i class="ti ti-at"></i></button>
	<button v-if="mfm" class="_button" :class="$style.footerButton" :aria-label="i18n.ts.addMfmFunction" :title="i18n.ts.addMfmFunction" @click="event => emit('mfm', event)"><i class="ti ti-palette"></i></button>
	<button v-if="plugins" class="_button" :class="$style.footerButton" :aria-label="i18n.ts.plugins" :title="i18n.ts.plugins" @click="event => emit('plugins', event)"><i class="ti ti-plug"></i></button>
	<button v-if="showPreview" class="_button" :class="[$style.footerButton, { [$style.footerButtonActive]: preview }]" :aria-label="i18n.ts.preview" :title="i18n.ts.preview" @click="event => emit('preview', event)"><i class="ti ti-eye"></i></button>
</div>
<div :class="$style.footerRight"><button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.emoji" :title="i18n.ts.emoji" @click="event => emit('emoji', event)"><i class="ti ti-mood-happy"></i></button></div>
</template>
<script setup lang="ts">
import { i18n } from '@/i18n.js';
withDefaults(defineProps<{ poll: boolean; useCw: boolean; canAttach?: boolean; drive?: boolean; hashtags?: boolean; showHashtags?: boolean; mfm?: boolean; plugins?: boolean; showPreview?: boolean; preview?: boolean }>(), { canAttach: true, mfm: true });
const emit = defineEmits<{ (event: 'upload' | 'drive' | 'poll' | 'cw' | 'hashtags' | 'mention' | 'mfm' | 'plugins' | 'preview' | 'emoji', value: PointerEvent): void }>();
</script>
<style lang="scss" module>
@use './post-form.scss';
</style>
