<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<nav :class="$style.nav" :aria-label="i18n.ts.drive"><div :class="$style.path"><slot/></div><div v-if="$slots.menu" :class="$style.menu"><slot name="menu"/></div></nav>
</template>
<script setup lang="ts">
import { i18n } from '@/i18n.js';
</script>
<style lang="scss" module>
.nav { display: flex; width: 100%; padding: 0 8px; box-sizing: border-box; overflow: auto; font-size: .9em; background: color(from var(--MI_THEME-bg) srgb r g b / .75); -webkit-backdrop-filter: var(--MI-blur, blur(15px)); backdrop-filter: var(--MI-blur, blur(15px)); border-bottom: solid .5px var(--MI_THEME-divider); }
.path { display: flex; align-items: center; min-height: 42px; white-space: nowrap; gap: 8px; }
.menu { display: flex; margin-left: auto; }
</style>
