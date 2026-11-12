<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :tabs="headerTabs" :swipable="true">
	<div class="_spacer _gaps" style="--MI_SPACER-w: 700px;" data-gridspace-channels>
		<MkA to="/channels">{{ i18n.ts.channel }}</MkA>
		<template v-if="!channelId">
			<MkInput v-model="query" type="search" @enter="load(false)"><template #label>{{ i18n.ts.search }}</template></MkInput>
			<MkSwitch v-model="followed" @update:modelValue="load(false)">{{ i18n.ts._gridspace.channelsFollowed }}</MkSwitch>
		</template>
		<MkButton v-if="!channelId || error" :disabled="loading" @click="refresh">{{ channelId ? i18n.ts.reload : i18n.ts.search }}</MkButton>
		<MkLoading v-if="loading"/>
		<MkInfo v-if="error" warn role="alert">{{ i18n.ts._gridspace.channelsUnavailable }} <MkA to="/settings/gridspace">{{ i18n.ts._gridspace.title }}</MkA></MkInfo>
		<MkGridspacePostForm v-if="channelId && composerReady && prefer.s.showFixedPostFormInChannel" v-show="selected && !selected.isArchived && (!selected.isSensitive || revealed) && tab === 'timeline'" :key="channelId" :channelId="channelId" :channel="selected" embedded :autofocus="deviceKind === 'desktop'" class="_panel" @sent="refreshNotes"/>
		<template v-if="selected">
			<section v-if="tab === 'overview'" class="_panel" :class="$style.overview">
				<div :class="$style.hero" :style="{ backgroundImage: selected.bannerUrl && (!selected.isSensitive || revealed) ? `url(${selected.bannerUrl})` : undefined }">
					<div :class="$style.statistics"><div><i class="ti ti-users ti-fw"></i> {{ i18n.tsx._channel.usersCount({ n: selected.usersCount }) }}</div><div><i class="ti ti-pencil ti-fw"></i> {{ i18n.tsx._channel.notesCount({ n: selected.notesCount }) }}</div></div>
					<span v-if="selected.isSensitive" :class="$style.sensitive">{{ i18n.ts.sensitive }}</span>
				</div>
				<div :class="$style.detail"><h2>{{ selected.name }}</h2><span :class="$style.origin">{{ originHost }}</span><Mfm v-if="selected.description" :text="selected.description" :isNote="false"/></div>
			</section>
			<MkInfo v-if="selected.isArchived" warn>{{ i18n.ts.thisChannelArchived }}</MkInfo>
			<MkButton v-if="selected.isSensitive && !revealed" @click="revealed = true">{{ i18n.ts._gridspace.channelShowSensitive }}</MkButton>
			<template v-if="!selected.isSensitive || revealed">
				<template v-if="tab === 'timeline'">
					<MkGridspacePrivateNotes :key="timelineKey" :params="{ mode: 'channel', channelId: selected.id }" plain alwaysShow @loaded="markRead"/>
				</template>
				<template v-else-if="tab === 'search'">
					<MkInput v-model="searchQuery" type="search" @enter="search"><template #prefix><i class="ti ti-search"></i></template></MkInput>
					<MkButton primary rounded @click="search">{{ i18n.ts.search }}</MkButton>
					<MkGridspacePrivateNotes v-if="appliedSearch" :key="appliedSearch" :params="{ mode: 'channel', channelId: selected.id, query: appliedSearch }" plain alwaysShow/>
				</template>
			</template>
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
	<template v-if="selected && !selected.isArchived && (!selected.isSensitive || revealed)" #footer>
		<div :class="$style.footer"><div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 16px;"><div class="_buttonsCenter"><MkButton inline rounded primary gradate @click="openPostForm"><i class="ti ti-pencil"></i> {{ i18n.ts.postToTheChannel }}</MkButton></div></div></div>
	</template>
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
import MkGridspacePostForm from '@/components/MkGridspacePostForm.vue';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { prefer } from '@/preferences.js';
import { deviceKind } from '@/utility/device-kind.js';
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
const tab = ref('timeline');
const headerTabs = computed(() => props.channelId ? [
	{ key: 'overview', title: i18n.ts.overview, icon: 'ti ti-info-circle' },
	{ key: 'timeline', title: i18n.ts.timeline, icon: 'ti ti-messages' },
	{ key: 'search', title: i18n.ts.search, icon: 'ti ti-search' },
] : []);
const searchQuery = ref('');
const appliedSearch = ref('');
const revealed = ref(false);
// Keep only the composer instance (and its in-memory draft) across channel revalidation.
const composerReady = ref(false);
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
	channels.value = []; next.value = null; loading.value = false; revealed.value = false;
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

function search() { appliedSearch.value = searchQuery.value.trim(); }

function openPostForm() { if (selected.value) void gridspacePost({ channelId: selected.value.id, channel: selected.value }, refreshNotes); }

function refresh() { refreshNotes(); void load(false); }

function visibility() { if (window.document.hidden) clear(); else void load(false); }

window.document.addEventListener('visibilitychange', visibility);
watch([selected, revealed], () => {
	if (selected.value && !selected.value.isArchived && (!selected.value.isSensitive || revealed.value)) composerReady.value = true;
});
watch(() => props.channelId, () => { composerReady.value = false; void load(false); }, { immediate: true });
onDeactivated(() => { active = false; composerReady.value = false; clear(); });
onActivated(() => { if (!active) { active = true; void load(false); } });
onBeforeUnmount(() => { clear(); window.document.removeEventListener('visibilitychange', visibility); });
definePage(() => ({ title: selected.value?.name ?? i18n.ts._gridspace.channels, icon: 'ti ti-device-tv' }));
</script>

<style lang="scss" module>
.detail { padding: var(--MI-margin); overflow-wrap: anywhere; }
.detail h2 { margin: 0; font-size: 1.25em; }
.overview { overflow: clip; }
.hero { height: 200px; position: relative; background: var(--MI_THEME-bg) center / cover; }
.statistics { position: absolute; bottom: 16px; right: 16px; background: var(--MI_THEME-tooltipBg); color: var(--MI_THEME-tooltipFg); padding: 8px 12px; border-radius: 6px; font-size: 0.8em; }
.sensitive { position: absolute; bottom: 16px; left: 16px; background: var(--MI_THEME-tooltipBg); color: var(--MI_THEME-warn); padding: 4px 7px; border-radius: 6px; }
.origin { display: block; margin-block: 8px; color: var(--MI_THEME-fgTransparentWeak); font-size: 0.85em; }
.footer { background: var(--MI_THEME-panel); border-top: solid 0.5px var(--MI_THEME-divider); }
.card { display: flex; flex-direction: column; gap: var(--MI-marginHalf); padding: var(--MI-margin); overflow-wrap: anywhere; }
.banner { width: 100%; max-height: 180px; object-fit: cover; border-radius: var(--MI-radius); }
</style>
