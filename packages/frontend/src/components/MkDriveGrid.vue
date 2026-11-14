<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="animated ? TransitionGroup : 'div'" tag="div" :class="[$style.grid, { [$style.inset]: inset }]" :enterActiveClass="prefer.s.animation ? $style.active : ''" :leaveActiveClass="prefer.s.animation ? $style.active : ''" :enterFromClass="prefer.s.animation ? $style.hidden : ''" :leaveToClass="prefer.s.animation ? $style.hidden : ''" :moveClass="prefer.s.animation ? $style.active : ''"><slot/></component>
</template>
<script setup lang="ts">
import { TransitionGroup } from 'vue';
import { prefer } from '@/preferences.js';
withDefaults(defineProps<{ animated?: boolean; inset?: boolean }>(), { animated: false, inset: true });
</script>
<style lang="scss" module>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.inset { padding: 16px 32px; }
.active { transition: all .2s ease; }
.hidden { opacity: 0; }
@container (max-width: 600px) { .inset { padding: 16px; } }
</style>
