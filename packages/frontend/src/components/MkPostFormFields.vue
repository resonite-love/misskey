<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-show="useCw" :class="$style.cwOuter"><slot name="cw"/></div>
<div :class="[$style.textOuter, { [$style.withCw]: useCw }]"><div v-if="channelColor" :class="$style.colorBar" :style="{ background: channelColor }"></div><slot/><slot name="counter"/></div>
</template>
<script setup lang="ts">
defineProps<{ useCw: boolean; channelColor?: string }>();
</script>
<style lang="scss" module>
@use './post-form.scss';
</style>
