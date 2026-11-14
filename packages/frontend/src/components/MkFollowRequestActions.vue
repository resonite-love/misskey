<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.followRequestCommands"><MkButton :class="$style.followRequestCommandButton" rounded primary :disabled="busy" @click="emit('decide', true)"><i class="ti ti-check"></i> {{ i18n.ts.accept }}</MkButton><MkButton :class="$style.followRequestCommandButton" rounded danger :disabled="busy" @click="emit('decide', false)"><i class="ti ti-x"></i> {{ i18n.ts.reject }}</MkButton></div>
</template>
<script setup lang="ts">
import MkButton from '@/components/MkButton.vue';
import $style from '@/components/notification.module.scss';
import { i18n } from '@/i18n.js';
defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ (event: 'decide', accept: boolean): void }>();
</script>
