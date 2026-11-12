<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_spacer" style="--MI_SPACER-w: 800px;">
	<XTimeline :key="user.id" :user="user"/>
</div>
</template>

<script lang="ts" setup>
import type * as Misskey from 'misskey-js';
import XTimeline from './index.timeline.vue';

defineProps<{
	user: Misskey.entities.UserDetailed;
}>();
</script>
