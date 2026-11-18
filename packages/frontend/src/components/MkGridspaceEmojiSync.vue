<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkFolder>
	<template #label>{{ t.title }}</template>
	<div class="_gaps">
		<MkInfo>{{ t.description }}</MkInfo>
		<MkInfo v-if="failed || status?.lastError" warn role="alert">{{ t.failedToLoad }}</MkInfo>
		<template v-if="status?.enabled">
			<div>{{ origin(status.originA) }} ↔ {{ origin(status.originB) }}</div>
			<p aria-live="polite">{{ i18n.tsx._gridspaceEmojiSync.counts(status.counts) }}</p>
			<small v-if="status.checkedAt">{{ t.lastChecked }}: <MkTime :time="status.checkedAt" mode="absolute"/></small>
		</template>
		<div class="_buttons">
			<MkButton :disabled="loading || busy" @click="load()">{{ i18n.ts.reload }}</MkButton>
			<MkButton v-if="status?.enabled" :disabled="loading || busy" @click="retry">{{ t.retry }}</MkButton>
			<MkA to="/admin/emojis">{{ t.manage }}</MkA>
		</div>
		<MkLoading v-if="!status && loading"/>
		<p v-if="status && !status.enabled">{{ t.disabled }}</p>
		<p v-if="status?.enabled && !status.items.length">{{ t.noIssues }}</p>
		<article v-for="item in status?.items ?? []" :key="item.id" class="_panel _gaps_s" :class="$style.item">
			<div>{{ stateLabel(item.state) }}<span v-if="item.reason"> · {{ reasonLabel(item.reason) }}</span></div>
			<div :class="$style.pair">
				<div v-for="side in (['a', 'b'] as const)" :key="side" :class="$style.side">
					<small>{{ origin(side === 'a' ? status!.originA : status!.originB) }}</small>
					<div v-if="item[side]" :class="$style.emoji">
						<img :src="item[side]!.originalUrl" :alt="item[side]!.name" loading="lazy"/>
						<code>{{ item[side]!.name }}</code>
					</div>
					<span v-else>{{ t.notPresent }}</span>
					<dl v-if="item[side]" :class="$style.metadata">
						<dt>{{ i18n.ts.category }}</dt><dd>{{ item[side]!.category || i18n.ts.none }}</dd>
						<dt>{{ t.aliases }}</dt><dd>{{ item[side]!.aliases.join(', ') || i18n.ts.none }}</dd>
						<dt>{{ i18n.ts.license }}</dt><dd>{{ item[side]!.license || i18n.ts.none }}</dd>
						<dt>{{ i18n.ts.sensitive }}</dt><dd>{{ item[side]!.isSensitive ? i18n.ts.yes : i18n.ts.no }}</dd>
						<dt>{{ i18n.ts.localOnly }}</dt><dd>{{ item[side]!.localOnly ? i18n.ts.yes : i18n.ts.no }}</dd>
					</dl>
				</div>
			</div>
			<div v-if="item.state === 'conflict' || item.state === 'failed' || item.state === 'ignored'" class="_buttons">
				<template v-if="item.state !== 'ignored'">
					<MkButton v-if="item.a" small :disabled="busy || loading || item.a.restricted || item.b?.restricted" @click="resolve(item, 'preferA')">{{ i18n.tsx._gridspaceEmojiSync.adopt({ host: origin(status!.originA) }) }}</MkButton>
					<MkButton v-if="item.b" small :disabled="busy || loading || item.a?.restricted || item.b.restricted" @click="resolve(item, 'preferB')">{{ i18n.tsx._gridspaceEmojiSync.adopt({ host: origin(status!.originB) }) }}</MkButton>
					<MkButton small :disabled="busy || loading" @click="resolve(item, 'ignore')">{{ t.ignore }}</MkButton>
				</template>
				<MkButton v-else small :disabled="busy || loading" @click="resolve(item, 'resume')">{{ t.resume }}</MkButton>
			</div>
		</article>
		<MkButton v-if="status?.next" :disabled="loading || busy" @click="load(true)">{{ i18n.ts.loadMore }}</MkButton>
	</div>
</MkFolder>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Endpoints } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';

type Status = Endpoints['admin/gridspace/emojis']['res'];
type Item = Status['items'][number];
const t = i18n.ts._gridspaceEmojiSync;
const status = ref<Status | null>(null);
const loading = ref(false), busy = ref(false), failed = ref(false);
let disposed = false;
const controller = new AbortController();

function origin(value: string | null) { return value ? new URL(value).host : ''; }

function stateLabel(value: string) { return ({ pending: t.pending, synced: t.synced, conflict: t.conflict, failed: t.failed, ignored: t.ignored } as Record<string, string>)[value] ?? value; }

function reasonLabel(value: string) {
	if (value === 'REMOVED') return t.removed;
	if (value === 'RESTRICTED' || value === 'ROLE_RESTRICTED') return t.restricted;
	if (['CONFLICT', 'EMOJI_CONFLICT', 'NAME_CONFLICT'].includes(value)) return t.different;
	if (value === 'IMAGE_UNAVAILABLE' || value === 'IMAGE_CHANGED') return t.imageFailed;
	return t.connectionFailed;
}

async function load(more = false) {
	if (loading.value || disposed) return;
	loading.value = true;
	try {
		const result = await misskeyApi('admin/gridspace/emojis', { action: 'status', ...(more && status.value?.next ? { after: status.value.next } : {}) }, undefined, controller.signal);
		if (disposed) return;
		if (more && status.value) result.items = [...new Map([...status.value.items, ...result.items].map(item => [item.id, item])).values()];
		status.value = result; failed.value = false;
	} catch { if (!disposed) failed.value = true; } finally { if (!disposed) loading.value = false; }
}

async function retry() {
	if (busy.value) return;
	busy.value = true;
	try { const result = await os.apiWithDialog('admin/gridspace/emojis', { action: 'retry' }); if (!disposed) { status.value = result; failed.value = false; } } finally { if (!disposed) busy.value = false; }
}

async function resolve(item: Item, action: 'preferA' | 'preferB' | 'ignore' | 'resume') {
	if (busy.value || !status.value) return;
	if (action === 'preferA' || action === 'preferB') {
		const side = action === 'preferA' ? item.a : item.b;
		const host = origin(action === 'preferA' ? status.value.originA : status.value.originB);
		const { canceled } = await os.confirm({ type: 'warning', text: i18n.tsx._gridspaceEmojiSync.confirm({ name: side?.name ?? '', host }) });
		if (canceled || disposed) return;
	}
	busy.value = true;
	try {
		const result = await os.apiWithDialog('admin/gridspace/emojis', { action, id: item.id, expectedA: item.a?.hash ?? null, expectedB: item.b?.hash ?? null });
		if (!disposed) { status.value = result; failed.value = false; }
	} finally { if (!disposed) busy.value = false; }
}

onMounted(() => { void load(); });
onBeforeUnmount(() => { disposed = true; controller.abort(); });
</script>

<style lang="scss" module>
.item { padding: 16px; border: 1px solid var(--MI_THEME-divider); }
.pair { display: flex; flex-wrap: wrap; gap: 16px; }
.side { flex: 1 1 180px; min-width: 0; }
.emoji { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.emoji img { width: 42px; height: 42px; object-fit: contain; }
.metadata { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 85%; }
.metadata dd { margin: 0; overflow-wrap: anywhere; }
</style>
