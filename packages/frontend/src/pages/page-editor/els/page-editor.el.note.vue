<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- eslint-disable vue/no-mutating-props -->
<XContainer :draggable="true" :dragStartCallback="dragStartCallback" @remove="() => emit('remove')">
	<template #header><i class="ti ti-note"></i> {{ i18n.ts._pages.blocks.note }}</template>

	<section style="padding: 16px;" class="_gaps_s">
		<MkInput v-model="id">
			<template #label>{{ i18n.ts._pages.blocks._note.id }}</template>
			<template #caption>{{ i18n.ts._pages.blocks._note.idDescription }}</template>
		</MkInput>
		<MkSwitch v-model="props.modelValue.detailed"><span>{{ i18n.ts._pages.blocks._note.detailed }}</span></MkSwitch>

		<MkNote v-if="note && !props.modelValue.detailed" :key="note.id + ':normal'" v-model:note="note" style="margin-bottom: 16px;"/>
		<MkNoteDetailed v-if="note && props.modelValue.detailed" :key="note.id + ':detail'" v-model:note="note" style="margin-bottom: 16px;"/>
		<MkGridspacePrivateNoteRow v-if="linkedNote" :note="linkedNote"/>
	</section>
</XContainer>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { watch, ref, inject, computed, onBeforeUnmount } from 'vue';
import * as Misskey from 'misskey-js';
import XContainer from '../page-editor.container.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkNote from '@/components/MkNote.vue';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';
import MkGridspacePrivateNoteRow from '@/components/MkGridspacePrivateNoteRow.vue';
import { url } from '@@/js/config.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{
	dragStartCallback?: (ev: DragEvent) => void;
	modelValue: Misskey.entities.PageBlock & { type: 'note' };
}>();

const emit = defineEmits<{
	(ev: 'update:modelValue', value: Misskey.entities.PageBlock & { type: 'note' }): void;
	(ev: 'remove'): void;
}>();

const id = ref(props.modelValue.note);
const note = ref<Misskey.entities.Note | null>(null);
const linkedNote = ref<Misskey.entities.GridspacePrivateNotesResponse['notes'][number] | null>(null);
const pageOrigin = inject('pageOrigin', computed(() => url));
let generation = 0;
const shown = ref(!window.document.hidden);
const onVisibility = () => { shown.value = !window.document.hidden; };
window.document.addEventListener('visibilitychange', onVisibility);
onBeforeUnmount(() => { generation++; window.document.removeEventListener('visibilitychange', onVisibility); });

watch([id, pageOrigin, shown], async () => {
	const current = ++generation;
	note.value = null; linkedNote.value = null;
	if (!shown.value) return;
	if (pageOrigin.value !== url) {
		if (!id.value) return;
		const value = id.value;
		const uri = /^https?:/.test(value) ? new URL(value) : null;
		const noteId = uri ? uri.pathname.split('/').at(-1)! : value;
		emit('update:modelValue', { ...props.modelValue, note: value });
		try {
			if (uri?.origin === url) {
				const loaded = await misskeyApi('notes/show', { noteId });
				if (current === generation) note.value = loaded;
			} else if (!uri || uri.origin === pageOrigin.value) {
				const loaded = await misskeyApi('gridspace/private-notes', { mode: 'show', noteId });
				if (current === generation) linkedNote.value = loaded.notes[0] ?? null;
			}
		} catch { /* Keep the input editable when a preview is unavailable. */ }
		return;
	}
	if (id.value && (id.value.startsWith('http://') || id.value.startsWith('https://'))) {
		id.value = (id.value.endsWith('/') ? id.value.slice(0, -1) : id.value).split('/').pop() ?? null;
	}

	if (!id.value) {
		note.value = null;
		return;
	}

	emit('update:modelValue', {
		...props.modelValue,
		note: id.value,
	});
	const loaded = await misskeyApi('notes/show', { noteId: id.value });
	if (current === generation) note.value = loaded;
}, {
	immediate: true,
});
</script>
