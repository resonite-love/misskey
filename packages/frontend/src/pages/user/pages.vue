<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_spacer" style="--MI_SPACER-w: 700px;">
	<MkGridspaceContentList kind="pages" :userId="user.id"/>
</div>
</template>

<script lang="ts" setup>
import type * as Misskey from 'misskey-js';
import MkGridspaceContentList from '@/components/MkGridspaceContentList.vue';

defineProps<{ user: Misskey.entities.User }>();
</script>
