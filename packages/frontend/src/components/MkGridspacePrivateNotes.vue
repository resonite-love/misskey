<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkLoading v-if="deciding"/>
<MkLegacyGridspacePrivateNotes v-else-if="!integrated" ref="legacy" v-bind="props" @loaded="emit('loaded')" @snapshot="note => emit('snapshot', note)"/>
<component :is="prefer.s.enablePullToRefresh && direction !== 'up' ? MkPullToRefresh : 'div'" v-else :refresher="refresh">
	<section ref="root" class="_panel _gaps_s" :class="$style.root" data-gridspace-private :aria-label="params.channelId ? i18n.ts.channel : i18n.ts._gridspace.privateTitle">
		<div v-if="!plain" :class="$style.heading" class="_gaps_s">
			<h2 :class="$style.title"><i class="ti ti-lock" aria-hidden="true"></i> {{ i18n.ts._gridspace.privateTitle }}</h2>
			<p>{{ i18n.ts._gridspace.privateScope }}</p>
		</div>
		<MkTimelineLoadMore v-if="direction === 'up'" :key="pagingKey" :hasMore="hasMore" :loading="loading" :disabled="error" :automatic="false" @load="load"/>
		<MkButton v-if="queuedCount" :class="$style.new" rounded primary @click="releaseQueue(true)">{{ i18n.ts.newNote }}</MkButton>
		<component :is="prefer.s.animation ? TransitionGroup : 'div'" tag="div" :enterActiveClass="$style.enterActive" :enterFromClass="$style.enterFrom" :moveClass="$style.move" @beforeLeave="clearLeavingPrivateNote">
			<MkTimelineNoteRow v-for="row in rows" :key="row.key" :row="row" :data-scroll-anchor="row.key" @unavailable="client?.fail()" @replied="refresh"/>
		</component>
		<div v-if="error || loading || (rows.length === 0 && !hasMore)" :class="$style.heading" class="_gaps_s">
			<p v-if="error" role="alert">{{ params.channelId ? i18n.ts._gridspace.channelNotesUnavailable : i18n.ts._gridspace.privateUnavailable }}</p>
			<MkLoading v-if="loading"/>
			<p v-else-if="!error && rows.length === 0 && !hasMore">{{ i18n.ts.noNotes }}</p>
			<MkButton v-if="error" :disabled="loading" @click="refresh">{{ i18n.ts.retry }}</MkButton>
		</div>
		<MkA v-if="needsAuthorization" to="/settings/gridspace" :class="$style.heading">{{ i18n.ts._gridspace.privateAuthorize }}</MkA>
		<MkTimelineLoadMore v-if="direction !== 'up'" :key="pagingKey" :hasMore="hasMore" :loading="loading" :disabled="error" @load="load"/>
	</section>
</component>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, TransitionGroup, useTemplateRef, watch } from 'vue';
import { isHeadVisible, onScrollTop, scrollToTop } from '@@/js/scroll.js';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkTimelineLoadMore from '@/components/MkTimelineLoadMore.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import MkTimelineNoteRow from '@/components/MkTimelineNoteRow.vue';
import MkLegacyGridspacePrivateNotes from '@/components/MkLegacyGridspacePrivateNotes.vue';
import { prefer } from '@/preferences.js';
import { TimelineClient } from '@/utility/timeline-client.js';
import { supportsTimelineKind } from '@/utility/timeline-capabilities.js';
import { subscribeTimeline } from '@/utility/timeline-stream.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { clearLeavingPrivateNote } from '@/utility/gridspace-note-suspension.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';

const props = defineProps<{ params: entities.GridspacePrivateNotesRequest; alwaysShow?: boolean; plain?: boolean; direction?: 'up' | 'down' }>();
const emit = defineEmits<{ (event: 'loaded'): void; (event: 'snapshot', note: entities.GridspacePrivateNotesResponse['notes'][number] | null): void }>();
const root = useTemplateRef('root');
const legacy = useTemplateRef('legacy');
const client = shallowRef<TimelineClient | null>(null);
const deciding = ref(true);
const integrated = ref(false);
let generation = 0;
let active = true;
let stopScroll: (() => void) | null = null;
const rows = computed(() => client.value?.rows.value ?? []);
const loading = computed(() => client.value?.busy.value ?? false);
const error = computed(() => client.value?.error.value ?? false);
const hasMore = computed(() => client.value?.hasMore.value ?? false);
const queuedCount = computed(() => client.value?.queuedCount.value ?? 0);
const pagingKey = computed(() => client.value?.pagingKey.value ?? 0);
const needsAuthorization = computed(() => client.value?.needsAuthorization.value ?? false);

async function select() {
	const current = ++generation;
	client.value?.dispose(); client.value = null; integrated.value = false; deciding.value = true;
	// The detail and private-only screens retain their existing result semantics.
	const kind = props.params.mode;
	if ($i && (kind === 'channel' || kind === 'antenna' || kind === 'clip')) {
		try {
			const status = await misskeyApi('gridspace/link', { action: 'status' });
			if (current !== generation) return;
			if (supportsTimelineKind(status, kind)) {
				const { mode: _mode, ...filters } = props.params;
				client.value = new TimelineClient({ ...filters, kind }, { isTop: () => !root.value || isHeadVisible(root.value), subscribe: subscribeTimeline });
				integrated.value = true;
				if (active) { await client.value.reload(); if (current === generation) emit('loaded'); }
			}
		} catch { /* Unknown capability retains the legacy component. */ }
	}
	if (current === generation) deciding.value = false;
}

async function load() { await client.value?.load(); emit('loaded'); }

async function refresh() {
	if (!integrated.value) { await legacy.value?.refresh(); return; }
	await client.value?.refresh(); releaseQueue(true); emit('loaded');
}

function releaseQueue(scroll = false) { client.value?.releaseQueue(); if (scroll && root.value) scrollToTop(root.value); }

function visibility() { if (window.document.hidden) client.value?.suspend(); else if (active) void client.value?.resume(); }

function focus() { if (active && !window.document.hidden) void client.value?.resume(); }

window.document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus);
watch(() => JSON.stringify(Object.entries(props.params).sort(([a], [b]) => a.localeCompare(b))), select, { immediate: true });
watch(root, element => {
	stopScroll?.();
	stopScroll = element ? onScrollTop(element, visible => { if (visible) releaseQueue(); }) : null;
});
onDeactivated(() => { active = false; client.value?.suspend(); });
onActivated(() => { if (!active) { active = true; focus(); } });
onBeforeUnmount(() => {
	generation++; active = false; client.value?.dispose(); stopScroll?.();
	window.document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
});
defineExpose({ refresh });
</script>

<style lang="scss" module>
.root { overflow: clip; }
.new { position: sticky; top: var(--MI-stickyTop, 0px); margin-inline: auto; z-index: 1; }
.enterActive { transition: transform 0.7s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.7s cubic-bezier(0.23, 1, 0.32, 1); }
.enterFrom { opacity: 0; transform: translateY(max(-64px, -100%)); }
.move { transition: transform 0.7s cubic-bezier(0.23, 1, 0.32, 1); }
.heading { padding: 16px; }
.title { font-size: 1em; margin: 0; }
</style>
