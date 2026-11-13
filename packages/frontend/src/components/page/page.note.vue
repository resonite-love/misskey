<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<a v-if="page.gridspaceOrigin && !note" :href="`${page.gridspaceOrigin}/notes/${block.note}`" target="_blank" rel="noopener noreferrer" class="_link">{{ i18n.ts.showOnRemote }}</a>
	<MkNote v-if="note && !block.detailed" :key="note.id + ':normal'" :note="note"/>
	<MkNoteDetailed v-if="note && block.detailed" :key="note.id + ':detail'" :note="note"/>
</div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import * as Misskey from 'misskey-js';
import MkNote from '@/components/MkNote.vue';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const props = defineProps<{
	block: Extract<Misskey.entities.PageBlock, { type: 'note' }>,
	page: Misskey.entities.Page,
}>();

const note = ref<Misskey.entities.Note | null>(null);

onMounted(() => {
	if (props.block.note == null) return;
	(props.page.gridspaceOrigin ? misskeyApi('ap/show', { uri: `${props.page.gridspaceOrigin}/notes/${props.block.note}` }).then(result => result.type === 'Note' ? result.object : null) : misskeyApi('notes/show', { noteId: props.block.note }))
		.then(result => {
			note.value = result;
		}).catch(() => { note.value = null; });
});
</script>

<style lang="scss" module>
.root {
	border: 1px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
}
</style>
