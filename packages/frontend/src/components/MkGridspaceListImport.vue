<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="available" class="_gaps_s">
	<MkButton :disabled="busy || result?.complete" @click="run(true)">{{ i18n.ts._gridspace.listsCopy }}</MkButton>
	<div v-if="result?.started" role="status">{{ i18n.tsx._gridspace.listsProgress({ done: result.done, total: result.total, failed: result.failed, skipped: result.skipped ?? 0 }) }}</div>
	<MkInfo v-if="result?.skipped">{{ i18n.ts._gridspace.listsSkipped }}</MkInfo>
	<MkInfo v-if="error" warn>{{ i18n.ts._gridspace.listsCopyFailed }}</MkInfo>
	<MkButton v-if="error" :disabled="busy" @click="run(true, true)">{{ i18n.ts.retry }}</MkButton>
</div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { userListsCache, antennasCache } from '@/cache.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{ autoStart?: boolean }>();
const available = ref(false);
const result = ref<entities.GridspaceListImportResponse | null>(null);
const busy = ref(false);
const error = ref(false);
let stopped = false;

async function run(start = false, retry = false) {
	if (busy.value || !available.value || stopped) return;
	busy.value = true; error.value = false;
	try {
		let state = await misskeyApi('gridspace/list-import', { action: start ? 'start' : 'status' });
		if (!start && state.started && state.pending) state = await misskeyApi('gridspace/list-import', { action: 'start' });
		if (retry) state = await misskeyApi('gridspace/list-import', { action: 'retry' });
		result.value = state;
		while (state.pending && !stopped) {
			await new Promise(resolve => window.setTimeout(resolve, 1200));
			if (stopped) break;
			state = await misskeyApi('gridspace/list-import', { action: 'step' });
			result.value = state;
		}
		error.value = state.failed > 0;
		userListsCache.delete();
		antennasCache.delete();
		await userListsCache.fetch();
		await antennasCache.fetch();
	} catch { error.value = true; } finally { busy.value = false; }
}

watch(() => props.autoStart, value => { if (value) void run(true); });
onMounted(async () => {
	try {
		const link = await misskeyApi('gridspace/link', {});
		available.value = link.channelsEnabled && link.initiator && link.state === 'active';
		await run(props.autoStart);
	} catch { /* Ordinary lists remain available when the peer is offline. */ }
});
onBeforeUnmount(() => { stopped = true; });
</script>
