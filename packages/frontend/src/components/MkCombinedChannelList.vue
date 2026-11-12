<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps" data-combined-channels>
	<div :class="grid ? $style.grid : '_gaps'">
		<MkChannelPreview v-for="item in items" :key="`${item.origin ?? ''}:${item.channel.id}`" :channel="item.channel" :origin="item.origin"/>
	</div>
	<MkLoading v-if="loading"/>
	<p v-else-if="!items.length && !localError && !peerError">{{ i18n.ts.noResults }}</p>
	<MkInfo v-if="localError" warn>{{ i18n.ts.somethingHappened }}</MkInfo>
	<MkInfo v-if="peerError" warn>{{ i18n.ts._gridspace.channelsUnavailable }} <MkA to="/settings/gridspace">{{ i18n.ts._gridspace.title }}</MkA></MkInfo>
	<MkButton v-if="localError || peerError" :disabled="loading" @click="retry">{{ i18n.ts.retry }}</MkButton>
	<MkButton v-if="hasMore" :disabled="loading" @click="loadMore">{{ i18n.ts.loadMore }}</MkButton>
</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import type { IPaginator } from '@/utility/paginator.js';
import MkChannelPreview from '@/components/MkChannelPreview.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = withDefaults(defineProps<{
	paginator: IPaginator<entities.Channel>;
	peerEnabled: boolean;
	peerParams: entities.GridspaceChannelsRequest;
	grid?: boolean;
}>(), { grid: true });
type PeerChannel = entities.GridspaceChannelsResponse['channels'][number];
const peerItems = shallowRef<PeerChannel[]>([]);
const origin = ref<string>();
const peerLoading = ref(false);
const peerError = ref(false);
const next = ref<string | null>(null);
const localError = computed(() => props.paginator.error.value);
const loading = computed(() => props.paginator.fetching.value || props.paginator.fetchingOlder.value || peerLoading.value);
const hasMore = computed(() => (!localError.value && props.paginator.canFetchOlder.value) || (!peerError.value && next.value != null));
const items = computed(() => {
	const rows = [
		...props.paginator.items.value.map(channel => ({ channel, origin: undefined as string | undefined })),
		...peerItems.value.map(channel => ({ channel, origin: origin.value })),
	];
	const time = (channel: typeof rows[number]['channel']) => Date.parse(props.peerParams.list === 'featured' ? channel.lastNotedAt ?? channel.createdAt : channel.createdAt);
	return rows.sort((a, b) => time(b.channel) - time(a.channel) || a.channel.id.localeCompare(b.channel.id));
});
let generation = 0;
let controller = new AbortController();

async function loadPeer(more = false) {
	if (!props.peerEnabled || peerLoading.value || (more && !next.value)) return;
	const current = generation;
	peerLoading.value = true; peerError.value = false;
	try {
		const result = await misskeyApi('gridspace/channels', { ...props.peerParams, limit: 10, before: more ? next.value! : undefined }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
		if (current !== generation) return;
		const seen = new Set(more ? peerItems.value.map(channel => channel.id) : []);
		peerItems.value = [...(more ? peerItems.value : []), ...result.channels.filter(channel => !seen.has(channel.id))];
		origin.value = result.origin; next.value = result.next;
	} catch {
		if (current === generation) { peerItems.value = []; peerError.value = true; next.value = null; }
	} finally { if (current === generation) peerLoading.value = false; }
}

async function loadMore() {
	if (loading.value) return;
	await Promise.all([!localError.value && props.paginator.canFetchOlder.value ? props.paginator.fetchOlder() : undefined, !peerError.value ? loadPeer(true) : undefined]);
}

async function retry() {
	await Promise.all([localError.value ? props.paginator.reload() : undefined, peerError.value ? loadPeer() : undefined]);
}

watch([() => props.paginator, () => JSON.stringify([props.peerEnabled, props.peerParams])], ([paginator], previous) => {
	if (paginator !== previous?.[0]) void paginator.init();
	generation++; controller.abort(); controller = new AbortController();
	peerItems.value = []; next.value = null; peerLoading.value = false; peerError.value = false;
	void loadPeer();
}, { immediate: true });
onBeforeUnmount(() => { generation++; controller.abort(); });
</script>

<style lang="scss" module>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: var(--MI-margin); }
</style>
