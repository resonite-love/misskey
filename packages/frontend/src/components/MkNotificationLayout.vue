<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.contentVisibilityAuto]: contentVisibilityAuto }]">
	<div :class="$style.head"><slot name="head"></slot></div>
	<div :class="$style.tail">
		<header :class="$style.header"><slot name="header"></slot><MkTime v-if="time" :time="time" :class="$style.headerTime"/></header>
		<slot></slot>
	</div>
</div>
</template>

<script setup lang="ts">
import $style from '@/components/notification.module.scss';
withDefaults(defineProps<{ time?: string; contentVisibilityAuto?: boolean }>(), { contentVisibilityAuto: true });
</script>
