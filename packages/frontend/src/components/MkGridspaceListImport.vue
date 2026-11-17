<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="available && (!summaryOnly || (result && !result.complete) || error)" class="_gaps_s">
	<MkA v-if="summaryOnly" to="/settings/gridspace">{{ i18n.ts._gridspace.manageImport }}</MkA>
	<MkButton v-else-if="!result?.complete" :disabled="busy" @click="run(true)">{{ shared ? i18n.ts._gridspace.listsCopyOnly : i18n.ts._gridspace.listsCopy }}</MkButton>
	<div v-if="result?.started" role="status">{{ (shared ? i18n.tsx._gridspace.listsProgressOnly : i18n.tsx._gridspace.listsProgress)({ done: result.done, total: result.total, failed: result.failed, skipped: result.skipped ?? 0 }) }}</div>
	<MkInfo v-if="!summaryOnly && result?.skipped">{{ i18n.ts._gridspace.listsSkipped }}</MkInfo>
	<MkInfo v-if="error" warn>{{ i18n.ts._gridspace.listsCopyFailed }}</MkInfo>
	<MkButton v-if="error && !summaryOnly" :disabled="busy" @click="run(true, true)">{{ i18n.ts.retry }}</MkButton>
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

const props = defineProps<{ autoStart?: boolean; summaryOnly?: boolean }>();
const available = ref(false);
const shared = ref(false);
const result = ref<entities.GridspaceListImportResponse | null>(null);
const busy = ref(false);
const error = ref(false);
let stopped = false;

async function run(start = false, retry = false) {
	if (busy.value || !available.value || stopped) return;
	busy.value = true; error.value = false;
	try {
		let state = await misskeyApi('gridspace/list-import', { action: start && !props.summaryOnly ? 'start' : 'status' });
		if (props.summaryOnly) { result.value = state; error.value = state.failed > 0; return; }
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
		shared.value = link.driveShared === true;
		available.value = link.channelsEnabled && link.initiator && link.state === 'active';
		await run(props.autoStart);
	} catch { /* Ordinary lists remain available when the peer is offline. */ }
});
onBeforeUnmount(() => { stopped = true; });
</script>
