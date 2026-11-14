<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.info"><MkA :to="to"><MkTime :time="createdAt" mode="detail" colored/></MkA><span :class="$style.visibility"><i :class="icon"></i> {{ i18n.ts._visibility[visibility] }}</span></div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { entities } from 'misskey-js';
import { i18n } from '@/i18n.js';
const props = defineProps<{ to: string; createdAt: string; visibility: entities.Note['visibility'] }>();
const icon = computed(() => ({ public: 'ti ti-world', home: 'ti ti-home', followers: 'ti ti-lock', specified: 'ti ti-mail' })[props.visibility]);
</script>
<style lang="scss" module>
.info { margin: 16px 0; opacity: .7; font-size: .9em; }
.visibility { margin-left: .5em; border-left: .5px solid var(--MI_THEME-divider); padding-left: .5em; }
</style>
