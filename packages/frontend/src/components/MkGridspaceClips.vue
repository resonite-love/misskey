<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" :refresher="reload">
	<div class="_gaps" data-gridspace-clips>
		<MkClipPreview v-for="row in rows" :key="row.key" :clip="row.clip" :peerOrigin="row.peerOrigin" :noUserInfo="true"/>
		<MkInfo v-if="localError || peerError" warn>{{ i18n.ts._gridspace.collectionsPartial }}</MkInfo>
		<MkButton v-if="localError || peerError" :disabled="busy" @click="reload">{{ i18n.ts.retry }}</MkButton>
		<MkA v-if="needsAuthorization" to="/settings/gridspace">{{ i18n.ts._gridspace.collectionsAuthorize }}</MkA>
		<MkLoading v-if="busy"/>
		<MkResult v-else-if="!localError && !peerError && !rows.length && !hasMore" type="empty"/>
		<MkTimelineLoadMore :hasMore="hasMore" :loading="busy" :disabled="checking" @load="load"/>
	</div>
</component>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkClipPreview from '@/components/MkClipPreview.vue';
import MkButton from '@/components/MkButton.vue';
import MkTimelineLoadMore from '@/components/MkTimelineLoadMore.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { prefer } from '@/preferences.js';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{ favorites?: boolean }>();
const local = shallowRef<entities.Clip[]>([]);
const peer = shallowRef<entities.Clip[]>([]);
const origin = ref<string>();
const localError = ref(false);
const peerError = ref(false);
const needsAuthorization = ref(false);
const busy = ref(false);
const localMore = ref(true);
const peerMore = ref(false);
const localBoundary = ref(Infinity);
const peerBoundary = ref(Infinity);
let localCursor: string | undefined;
let peerCursor: string | undefined;
let peerIds: string[] = [];
let generation = 0;
let peerInitialized = false;
const checking = ref(false);
let active = true;
let controller = new AbortController();
const kind = computed(() => props.favorites ? 'clip-favorites' as const : 'clips' as const);
const hasMore = computed(() => (!localError.value && localMore.value) || (!peerError.value && peerMore.value));
const rows = computed(() => {
	const boundary = Math.max(localError.value ? -Infinity : localBoundary.value, peerError.value || needsAuthorization.value ? -Infinity : peerBoundary.value);
	return [...local.value.map(clip => ({ key: `local:${clip.id}`, clip, peerOrigin: undefined as string | undefined })), ...peer.value.map(clip => ({ key: `peer:${clip.id}`, clip, peerOrigin: origin.value }))]
		.filter(row => Date.parse(row.clip.createdAt) > boundary)
		.sort((a, b) => Date.parse(b.clip.createdAt) - Date.parse(a.clip.createdAt) || a.key.localeCompare(b.key));
});
const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);

async function fetchLocal(current: number) {
	try {
		const page = props.favorites ? await misskeyApi('clips/my-favorites', {}, undefined, signal()) : await misskeyApi('clips/list', { untilId: localCursor, limit: 20 }, undefined, signal());
		if (current !== generation) return;
		local.value = [...new Map([...local.value, ...page].map(c => [c.id, c])).values()];
		localMore.value = !props.favorites && page.length === 20;
		localCursor = page.at(-1)?.id;
		localBoundary.value = localMore.value ? Date.parse(page.at(-1)!.createdAt) : -Infinity;
	} catch { if (current === generation) localError.value = true; }
}

async function fetchPeer(current: number) {
	try {
		const page = await misskeyApi('gridspace/collections', { kind: kind.value, before: peerCursor, limit: 20 }, undefined, signal());
		if (current !== generation) return;
		origin.value = page.origin ?? undefined;
		peer.value = [...new Map([...peer.value, ...page.clipsList].map(c => [c.id, c])).values()];
		peerIds = peer.value.map(c => c.id);
		peerMore.value = page.next != null;
		peerCursor = page.next ?? undefined;
		if (page.next && !Number.isFinite(Date.parse(page.scannedThrough ?? ''))) throw new Error('Invalid boundary');
		peerBoundary.value = page.next ? Date.parse(page.scannedThrough!) : -Infinity;
	} catch { if (current === generation) { peer.value = []; peerIds = []; peerError.value = true; } }
}

async function load() {
	if (busy.value || checking.value || !active || window.document.hidden) return;
	busy.value = true;
	const current = generation;
	const n = localError.value ? -Infinity : localBoundary.value;
	const p = peerError.value ? -Infinity : peerBoundary.value;
	await Promise.all([...(localMore.value && !localError.value && n >= p ? [fetchLocal(current)] : []), ...(peerMore.value && !peerError.value && p >= n ? [fetchPeer(current)] : [])]);
	if (current === generation) busy.value = false;
}

async function reload() {
	const current = ++generation; controller.abort(); controller = new AbortController();
	peerInitialized = false; checking.value = false;
	local.value = []; peer.value = []; peerIds = []; localCursor = peerCursor = undefined;
	localError.value = peerError.value = needsAuthorization.value = false;
	localMore.value = true; peerMore.value = false; localBoundary.value = peerBoundary.value = Infinity; busy.value = true;
	await Promise.all([fetchLocal(current), (async () => {
		try {
			const status = await misskeyApi('gridspace/collections', { kind: 'status' }, undefined, signal());
			if (current !== generation) return;
			if (!status.enabled) { peerBoundary.value = -Infinity; return; }
			if (!(props.favorites ? status.clipFavorites : status.clips)) { needsAuthorization.value = true; peerBoundary.value = -Infinity; return; }
			await fetchPeer(current);
		} catch { if (current === generation) peerError.value = true; } finally { if (current === generation) peerInitialized = true; }
	})()]);
	if (current === generation) busy.value = false;
}

async function validate() {
	if (!active || window.document.hidden || busy.value || checking.value || peerError.value || !peerIds.length) return;
	const current = generation;
	checking.value = true;
	const checked: entities.Clip[] = [];
	try {
		for (let i = 0; i < peerIds.length; i += 20) {
			const page = await misskeyApi('gridspace/collections', { kind: kind.value, ids: peerIds.slice(i, i + 20), limit: 20 }, undefined, signal());
			if (current !== generation) return;
			checked.push(...page.clipsList);
		}
		peer.value = checked; peerIds = checked.map(c => c.id);
	} catch { if (current === generation) { peer.value = []; peerIds = []; peerError.value = true; } } finally { if (current === generation) checking.value = false; }
}

function suspend() { generation++; controller.abort(); controller = new AbortController(); peer.value = []; busy.value = false; checking.value = false; }

function visibility() { if (window.document.hidden) suspend(); else if (!peerInitialized || !local.value.length) void reload(); else void validate(); }

window.document.addEventListener('visibilitychange', visibility);
const timer = window.setInterval(validate, 15000);
watch(kind, reload, { immediate: true });
onDeactivated(() => { active = false; suspend(); });
onActivated(() => { if (!active) { active = true; if (!peerInitialized) void reload(); else void validate(); } });
onBeforeUnmount(() => { active = false; suspend(); window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); });
defineExpose({ reload });
</script>
