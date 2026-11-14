<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<article :class="[$style.article, { [$style.compactTop]: compactTop }]" data-note-detailed-article>
	<slot name="header"/>
	<div :class="$style.content"><slot/></div>
	<MkNoteChannel v-if="channel && showChannelLink" :channel="channel" :to="channelTo"/>
	<slot name="reactions"/>
	<footer v-if="$slots.footer"><slot name="footer" :buttonClass="$style.button"/></footer>
</article>
</template>
<script setup lang="ts">
import MkNoteChannel from '@/components/MkNoteChannel.vue';
withDefaults(defineProps<{ channel?: { id: string; name: string; color: string } | null; channelTo?: string; showChannelLink?: boolean; compactTop?: boolean }>(), { showChannelLink: true });
</script>
<style lang="scss" module>
.article { position: relative; padding: 32px; font-size: 1.2em; }
.compactTop { padding-top: 8px; }
.content { container-type: inline-size; overflow-wrap: break-word; }
.button { margin: 0; padding: 8px; opacity: .7; &:not(:last-child) { margin-right: 28px; } &:hover { color: var(--MI_THEME-fgHighlighted); } }
@container (max-width: 450px) { .article { padding: 16px; } }
@container (max-width: 350px) { .button:not(:last-child) { margin-right: 18px; } }
@container (max-width: 300px) { .button:not(:last-child) { margin-right: 12px; } }
</style>
