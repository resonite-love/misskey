<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.cw">
	<Mfm v-if="cw" :text="cw" :author="author" :emojiUrls="emojiUrls" :nyaize="'respect'" :enableEmojiMenu="interactive" :enableEmojiMenuReaction="interactive"/>
	<MkCwButton v-model="expanded" :text="text" :files="files" :poll="poll" :renote="renote" :class="$style.button"/>
</div>
</template>

<script setup lang="ts">
import type { entities } from 'misskey-js';
import type { MfmBaseProps } from '@@/js/mfm-renderer.js';
import MkCwButton from '@/components/MkCwButton.vue';
const expanded = defineModel<boolean>({ required: true });
defineProps<{ cw: string; text: string | null; author?: MfmBaseProps['author']; emojiUrls?: Record<string, string>; files?: Pick<entities.DriveFile, 'id'>[]; poll?: entities.Note['poll']; renote?: entities.Note | null; interactive?: boolean }>();
</script>

<style lang="scss" module>
.cw { cursor: default; display: block; margin: 0; padding: 0; overflow-wrap: break-word; }
.button { margin: 4px 0; }
</style>
