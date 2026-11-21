<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="clips.length || failed" class="_margin _gaps">
	<template v-if="clips.length">
		<div :class="$style.heading">{{ i18n.ts.clip }}</div>
		<MkClipPreview v-for="clip in clips" :key="`${clip.gridspaceOrigin ?? ''}:${clip.id}`" :clip="clip" :peerOrigin="clip.gridspaceOrigin"/>
	</template>
	<MkInfo v-if="failed" warn>
		{{ i18n.ts._gridspace.collectionsPartial }}
		<MkButton small :disabled="loading" @click="load">{{ i18n.ts.retry }}</MkButton>
	</MkInfo>
</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkClipPreview from '@/components/MkClipPreview.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkButton from '@/components/MkButton.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = withDefaults(defineProps<{ noteId: string; source?: 'local' | 'peer'; channelId?: string; conversationUri?: string }>(), { source: 'local' });
const clips = ref<entities.Clip[]>([]);
const failed = ref(false);
const loading = ref(false);
let generation = 0;
let controller = new AbortController();

async function load() {
	controller.abort(); controller = new AbortController();
	const current = ++generation;
	loading.value = true; failed.value = false;
	try {
		const result = await misskeyApi('gridspace/note-clips', { noteId: props.noteId, source: props.source, ...(props.conversationUri ? { conversationUri: props.conversationUri } : { channelId: props.channelId }) }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
		if (current !== generation) return;
		clips.value = result.clips;
		failed.value = result.partial;
	} catch {
		if (current === generation) { clips.value = []; failed.value = true; }
	} finally { if (current === generation) loading.value = false; }
}

watch(() => [props.noteId, props.source, props.channelId, props.conversationUri], () => { clips.value = []; void load(); }, { immediate: true });
onBeforeUnmount(() => { generation++; controller.abort(); });
</script>

<style lang="scss" module>
.heading { font-weight: bold; padding: 12px; }
</style>
