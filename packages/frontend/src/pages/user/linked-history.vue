<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkGridspaceNoteList ref="list" :source="{ kind: 'profile', ...props }" @unavailable="emit('unavailable')"/>
</template>

<script lang="ts" setup>
import { useTemplateRef } from 'vue';
import MkGridspaceNoteList from '@/components/MkGridspaceNoteList.vue';

const props = withDefaults(defineProps<{
	userId: string;
	linked?: boolean;
	withReplies: boolean;
	withRenotes: boolean;
	withFiles: boolean;
	withChannelNotes: boolean;
}>(), { linked: true });
const emit = defineEmits<{ (event: 'unavailable'): void }>();
const list = useTemplateRef('list');
defineExpose({ reload: () => list.value?.reload() });
</script>
