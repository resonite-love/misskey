<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div>
	<div v-if="note && showNext" class="_margin">
		<MkGridspacePrivateNotes :key="`newer:${note.id}:${showNext}`" :params="contextParams(showNext, 'oldest')" direction="up" plain alwaysShow/>
	</div>
	<div v-if="note && !showNext && !conversationUri" class="_buttons" :class="$style.navigation">
		<MkButton v-if="note.channelId" rounded :aria-label="i18n.ts._gridspace.newerChannelNotes" @click="showNext = 'channel'"><i class="ti ti-chevron-up"></i> <i class="ti ti-device-tv"></i></MkButton>
		<MkButton rounded :aria-label="i18n.ts._gridspace.newerUserNotes" @click="showNext = 'user'"><i class="ti ti-chevron-up"></i> <i class="ti ti-user"></i></MkButton>
	</div>
	<div class="_margin">
		<MkGridspacePrivateNotes :key="`${noteId}:${channelId ?? ''}:${conversationUri ?? ''}`" :params="{ mode: 'show', noteId, channelId, conversationUri }" plain alwaysShow @replied="conversationRevision++" @snapshot="updateNote"/>
	</div>
	<MkNoteClips v-if="appearNote" :key="appearNote.id" :noteId="appearNote.id" source="peer" :conversationUri="clipConversationUri" :channelId="clipConversationUri ? undefined : appearNote.channelId ?? channelId"/>
	<div v-if="note && !showPrev && !conversationUri" class="_buttons" :class="$style.navigation">
		<MkButton v-if="note.channelId" rounded :aria-label="i18n.ts._gridspace.olderChannelNotes" @click="showPrev = 'channel'"><i class="ti ti-chevron-down"></i> <i class="ti ti-device-tv"></i></MkButton>
		<MkButton rounded :aria-label="i18n.ts._gridspace.olderUserNotes" @click="showPrev = 'user'"><i class="ti ti-chevron-down"></i> <i class="ti ti-user"></i></MkButton>
	</div>
	<div v-if="conversationUri && note" class="_margin">
		<MkGridspacePrivateNotes :key="conversationRevision" :params="{ mode: 'context', noteId, conversationUri, order: 'oldest' }" :excludeId="noteId" plain alwaysShow/>
	</div>
	<div v-if="note && showPrev" class="_margin">
		<MkGridspacePrivateNotes :key="`older:${note.id}:${showPrev}`" :params="contextParams(showPrev, 'newest')" plain alwaysShow/>
	</div>
</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import { conversationTarget } from '@/utility/gridspace-conversation.js';
import MkNoteClips from '@/components/MkNoteClips.vue';
import MkGridspacePrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import { i18n } from '@/i18n.js';

type Note = entities.GridspacePrivateNotesResponse['notes'][number];
const props = defineProps<{ noteId: string; channelId?: string; conversationUri?: string }>();
const emit = defineEmits<{ (event: 'snapshot', note: Note | null): void }>();
const note = ref<Note | null>(null);
const conversationRevision = ref(0);
const appearNote = computed(() => {
	const value = note.value;
	return value?.renote && value.renoteId && value.text == null && value.cw == null && !value.replyId && !value.files.length && !value.poll ? value.renote : value;
});
const clipConversationUri = computed(() => appearNote.value ? conversationTarget(appearNote.value).conversationUri ?? (appearNote.value.id === props.noteId ? props.conversationUri : undefined) : undefined);
const showNext = ref<'channel' | 'user' | false>(false);
const showPrev = ref<'channel' | 'user' | false>(false);

function updateNote(value: Note | null) {
	note.value = value;
	emit('snapshot', value);
}

function contextParams(scope: 'channel' | 'user', order: 'oldest' | 'newest'): entities.GridspacePrivateNotesRequest {
	return { mode: 'context', contextScope: scope, noteId: props.noteId, channelId: note.value?.channelId ?? props.channelId, order };
}

watch(() => [props.noteId, props.channelId, props.conversationUri], () => {
	showNext.value = false; showPrev.value = false; updateNote(null);
});
</script>

<style lang="scss" module>
.navigation { justify-content: center; margin-block: var(--MI-margin); }
</style>
