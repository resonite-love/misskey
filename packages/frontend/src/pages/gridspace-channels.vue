<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer _gaps" style="--MI_SPACER-w: 800px;" data-gridspace-channels>
		<MkA to="/channels">{{ i18n.ts.channel }}</MkA>
		<template v-if="!channelId">
			<MkInput v-model="query" type="search" @enter="load(false)"><template #label>{{ i18n.ts.search }}</template></MkInput>
			<MkSwitch v-model="followed" @update:modelValue="load(false)">{{ i18n.ts._gridspace.channelsFollowed }}</MkSwitch>
		</template>
		<MkButton :disabled="loading" @click="refresh">{{ channelId ? i18n.ts.reload : i18n.ts.search }}</MkButton>
		<MkLoading v-if="loading"/>
		<MkInfo v-if="error" warn role="alert">{{ i18n.ts._gridspace.channelsUnavailable }} <MkA to="/settings/gridspace">{{ i18n.ts._gridspace.title }}</MkA></MkInfo>
		<template v-if="selected">
			<section class="_panel _gaps" :class="$style.detail">
				<img v-if="selected.bannerUrl && !selected.isSensitive" :src="selected.bannerUrl" alt="" :class="$style.banner">
				<h2>{{ selected.name }}</h2>
				<span>{{ originHost }}</span>
				<Mfm v-if="selected.description" :text="selected.description" :plain="true"/>
				<MkInfo v-if="selected.isArchived">{{ i18n.ts._gridspace.channelArchived }}</MkInfo>
				<MkButton v-if="selected.isSensitive && !revealed" @click="revealed = true">{{ i18n.ts._gridspace.channelShowSensitive }}</MkButton>
				<template v-else-if="!selected.isArchived">
					<MkButton v-if="!composing" primary @click="composing = true">{{ i18n.ts._gridspace.channelPost }}</MkButton>
					<MkGridspaceReply v-else :channelId="selected.id" @close="composing = false" @sent="refreshNotes"/>
				</template>
			</section>
			<MkGridspacePrivateNotes v-if="!selected.isSensitive || revealed" :key="timelineKey" :params="{ mode: 'channel', channelId: selected.id }" plain alwaysShow @loaded="markRead"/>
		</template>
		<template v-else-if="!channelId">
			<MkA v-for="channel in channels" :key="channel.id" :to="`/gridspace/channels/${channel.id}`" class="_panel" :class="$style.card">
				<img v-if="channel.bannerUrl && !channel.isSensitive" :src="channel.bannerUrl" alt="" :class="$style.banner" loading="lazy">
				<strong><i class="ti ti-device-tv" aria-hidden="true"></i> {{ channel.name }}</strong>
				<span v-if="channel.isSensitive">{{ i18n.ts._gridspace.channelSensitive }}</span>
				<span>{{ i18n.tsx._gridspace.channelNoteCount({ count: channel.notesCount }) }}</span>
			</MkA>
			<p v-if="!loading && !error && !channels.length">{{ i18n.ts.noResults }}</p>
			<MkButton v-if="next" :disabled="loading" @click="load(true)">{{ i18n.ts.loadMore }}</MkButton>
		</template>
	</div>
</PageWithHeader>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkGridspacePrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import MkGridspaceReply from '@/components/MkGridspaceReply.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import { miLocalStorage } from '@/local-storage.js';

const props = defineProps<{ channelId?: string }>();
type Channel = entities.GridspaceChannelsResponse['channels'][number];
const channels = shallowRef<Channel[]>([]);
const selected = computed(() => props.channelId ? channels.value.find(channel => channel.id === props.channelId) : undefined);
const query = ref('');
const followed = ref(false);
const origin = ref('');
const originHost = computed(() => origin.value ? new URL(origin.value).host : '');
const next = ref<string | null>(null);
const loading = ref(false);
const error = ref(false);
const composing = ref(false);
const revealed = ref(false);
const timelineKey = ref(0);
let generation = 0;
let appliedQuery: string | undefined;
let active = true;
let controller = new AbortController();

function markRead() {
	if (selected.value && origin.value && !window.document.hidden) miLocalStorage.setItemAsJson(`channelLastReadedAt:${origin.value}:${selected.value.id}`, Date.now());
}

function clear() {
	generation++; controller.abort(); controller = new AbortController();
	channels.value = []; next.value = null; loading.value = false; composing.value = false; revealed.value = false;
}

async function load(more: boolean) {
	if (!active || window.document.hidden || (more && (loading.value || !next.value))) return;
	if (!more) { clear(); appliedQuery = query.value.trim() || undefined; }
	const current = generation;
	loading.value = true; error.value = false;
	try {
		const result = await misskeyApi('gridspace/channels', {
			channelId: props.channelId, query: appliedQuery, followed: followed.value, before: more ? next.value! : undefined,
		}, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
		if (current !== generation) return;
		if (props.channelId && !result.channels.length) throw new Error('Unavailable');
		const seen = new Set(channels.value.map(channel => channel.id));
		channels.value = [...channels.value, ...result.channels.filter(channel => !seen.has(channel.id))];
		origin.value = new URL(result.origin).origin; next.value = result.next;
	} catch { if (current === generation) { clear(); error.value = true; } } finally { if (current === generation) loading.value = false; }
}

function refreshNotes() { timelineKey.value++; }

function refresh() { refreshNotes(); void load(false); }

function visibility() { if (window.document.hidden) clear(); else void load(false); }

window.document.addEventListener('visibilitychange', visibility);
watch(() => props.channelId, () => load(false), { immediate: true });
onDeactivated(() => { active = false; clear(); });
onActivated(() => { if (!active) { active = true; void load(false); } });
onBeforeUnmount(() => { clear(); window.document.removeEventListener('visibilitychange', visibility); });
definePage(() => ({ title: selected.value?.name ?? i18n.ts._gridspace.channels, icon: 'ti ti-device-tv' }));
</script>

<style lang="scss" module>
.detail { padding: var(--MI-margin); overflow-wrap: anywhere; }
.detail h2 { margin: 0; font-size: 1.25em; }
.card { display: flex; flex-direction: column; gap: var(--MI-marginHalf); padding: var(--MI-margin); overflow-wrap: anywhere; }
.banner { width: 100%; max-height: 180px; object-fit: cover; border-radius: var(--MI-radius); }
</style>
