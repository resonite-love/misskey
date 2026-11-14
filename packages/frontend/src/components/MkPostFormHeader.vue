<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<header :class="$style.header"><div :class="$style.left"><button v-if="!fixed" class="_button" :class="$style.cancel" :aria-label="i18n.ts.close" @click="emit('cancel')"><i class="ti ti-x"></i></button><slot name="account"/></div><div :class="$style.right"><slot/></div></header>
</template>
<script setup lang="ts">
import { i18n } from '@/i18n.js';
defineProps<{ fixed?: boolean }>();
const emit = defineEmits<{ (event: 'cancel'): void }>();
</script>
<style lang="scss" module>
.header { z-index: 1000; min-height: 50px; display: flex; flex-wrap: nowrap; gap: 4px; }
.left { display: flex; flex: 1; min-width: 0; flex-wrap: nowrap; align-items: center; gap: 6px; padding-left: 12px; }
.right { display: flex; min-height: 48px; font-size: .9em; flex-wrap: nowrap; align-items: center; margin-left: auto; gap: 4px; overflow: clip; padding-left: 4px; }
.cancel { padding: 8px; }
</style>
