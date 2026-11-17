<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer _gaps" style="--MI_SPACER-w: 800px;">
		<template v-if="!noteId">
			<p>{{ i18n.ts._gridspace.privateListMoved }}</p>
			<div class="_buttons">
				<MkA to="/">{{ i18n.ts._gridspace.openHome }}</MkA>
				<MkA to="/search">{{ i18n.ts.search }}</MkA>
				<MkA v-if="channelId" :to="`/gridspace/channels/${channelId}`">{{ i18n.ts.channel }}</MkA>
			</div>
		</template>
		<template v-else-if="!$i">
			<MkLoading v-if="visitorLoading"/>
			<template v-else>
				<p role="alert">{{ i18n.ts.invisibleNote }}</p>
				<div class="_buttons">
					<MkButton @click="openPublicNote">{{ i18n.ts.retry }}</MkButton>
					<MkButton @click="pleaseLogin()">{{ i18n.ts.login }}</MkButton>
				</div>
			</template>
		</template>
		<MkGridspaceNoteDetail v-else :noteId="noteId" :channelId="channelId" @snapshot="createdAt = $event?.createdAt ?? null"/>
	</div>
</PageWithHeader>
</template>

<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import MkGridspaceNoteDetail from '@/components/MkGridspaceNoteDetail.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { dateString } from '@/filters/date.js';
import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { pleaseLogin } from '@/utility/please-login.js';
import { url } from '@@/js/config.js';

const props = defineProps<{ noteId?: string; channelId?: string }>();
const createdAt = ref<string | null>(null);
const visitorLoading = ref(false);
let visitorGeneration = 0;
let visitorController = new AbortController();
let visitorActive = true;

async function openPublicNote() {
	if (!visitorActive || $i) return;
	visitorController.abort(); visitorController = new AbortController();
	const current = ++visitorGeneration;
	visitorLoading.value = true;
	try {
		if (!props.noteId) return;
		const link = new URL('/gridspace/private', url);
		link.searchParams.set('noteId', props.noteId);
		if (props.channelId) link.searchParams.set('channelId', props.channelId);
		const result = await misskeyApi('gridspace/note-link', { url: link.href }, undefined, AbortSignal.any([visitorController.signal, AbortSignal.timeout(15000)]));
		if (visitorActive && current === visitorGeneration && result.publicUrl) window.location.replace(result.publicUrl);
	} catch { /* Unavailable posts never disclose their source or body. */ } finally { if (current === visitorGeneration) visitorLoading.value = false; }
}

watch(() => [props.noteId, props.channelId], () => { createdAt.value = null; if (!$i) void openPublicNote(); }, { immediate: true });

function stopVisitorRead() { visitorActive = false; visitorGeneration++; visitorController.abort(); visitorLoading.value = false; }

onDeactivated(stopVisitorRead);
onActivated(() => { const resume = !visitorActive; visitorActive = true; if (resume && !$i) void openPublicNote(); });
onBeforeUnmount(stopVisitorRead);
definePage(() => ({ title: props.noteId ? i18n.ts.note : i18n.ts.notes, subtitle: props.noteId && createdAt.value ? dateString(createdAt.value) : undefined, icon: 'ti ti-note' }));
</script>
