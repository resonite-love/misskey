<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer _gaps" style="--MI_SPACER-w: 800px;">
		<MkA to="/settings/gridspace">{{ i18n.ts._gridspace.title }}</MkA>
		<MkInput v-if="!noteId" v-model="query" type="search" @enter="search = query.trim()">
			<template #label>{{ i18n.ts.search }}</template>
		</MkInput>
		<MkButton v-if="!noteId" @click="search = query.trim()">{{ i18n.ts.search }}</MkButton>
		<MkA v-if="channelId" :to="`/gridspace/channels/${channelId}`">{{ i18n.ts.channel }}</MkA>
		<MkA v-else-if="noteId" to="/gridspace/private">{{ i18n.ts._gridspace.privateHome }}</MkA>
		<MkGridspacePrivateNotes :params="noteId ? { mode: 'show', noteId, channelId } : search ? { mode: 'search', query: search } : { mode: 'home' }" :plain="!!channelId" :alwaysShow="true"/>
	</div>
</PageWithHeader>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import MkGridspacePrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

const props = defineProps<{ noteId?: string; channelId?: string }>();
const query = ref('');
const search = ref('');
definePage(() => ({ title: props.channelId ? i18n.ts.channel : i18n.ts._gridspace.privateTitle, icon: props.channelId ? 'ti ti-device-tv' : 'ti ti-lock' }));
</script>
