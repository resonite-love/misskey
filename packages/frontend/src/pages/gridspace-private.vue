<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer _gaps" style="--MI_SPACER-w: 800px;">
		<MkGridspaceNoteDetail v-if="noteId" :noteId="noteId" :channelId="channelId" @snapshot="createdAt = $event?.createdAt ?? null"/>
		<template v-else>
			<MkA to="/settings/gridspace">{{ i18n.ts._gridspace.title }}</MkA>
			<MkInput v-model="query" type="search" @enter="search = query.trim()">
				<template #label>{{ i18n.ts.search }}</template>
			</MkInput>
			<MkButton @click="search = query.trim()">{{ i18n.ts.search }}</MkButton>
			<MkA v-if="channelId" :to="`/gridspace/channels/${channelId}`">{{ i18n.ts.channel }}</MkA>
			<MkGridspacePrivateNotes :params="search ? { mode: 'search', query: search } : { mode: 'home' }" :plain="!!channelId" :alwaysShow="true"/>
		</template>
	</div>
</PageWithHeader>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import MkGridspaceNoteDetail from '@/components/MkGridspaceNoteDetail.vue';
import MkGridspacePrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { dateString } from '@/filters/date.js';

const props = defineProps<{ noteId?: string; channelId?: string }>();
const query = ref('');
const search = ref('');
const createdAt = ref<string | null>(null);
watch(() => [props.noteId, props.channelId], () => { createdAt.value = null; });
definePage(() => ({ title: props.noteId ? i18n.ts.note : props.channelId ? i18n.ts.channel : i18n.ts._gridspace.privateTitle, subtitle: props.noteId && createdAt.value ? dateString(createdAt.value) : undefined, icon: 'ti ti-note' }));
</script>
