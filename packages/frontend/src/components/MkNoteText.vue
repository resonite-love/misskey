<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<Mfm v-bind="props" class="_selectable"/>
</template>

<script setup lang="ts">
import type { MfmBaseProps } from '@@/js/mfm-renderer.js';

const props = withDefaults(defineProps<MfmBaseProps & {
	enableEmojiMenu?: boolean;
	enableEmojiMenuReaction?: boolean;
}>(), { nyaize: 'respect', enableEmojiMenu: false, enableEmojiMenuReaction: false });
</script>
