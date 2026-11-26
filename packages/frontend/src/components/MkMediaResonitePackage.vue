<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<button v-if="hide" type="button" class="_button" :class="$style.sensitive" @click.stop="reveal">
		<i class="ti ti-alert-triangle" :class="$style.icon"></i>
		<span><b>{{ i18n.ts.sensitive }}</b><span :class="$style.caption">{{ i18n.ts._resonitePackage.format }} · {{ bytes(media.size, 1) }} · {{ i18n.ts.clickToShow }}</span></span>
	</button>
	<template v-else>
		<div :class="$style.header">
			<img v-if="info?.thumbnailDataUrl" :class="$style.thumbnail" :src="info.thumbnailDataUrl" :alt="title" width="72" height="72" loading="lazy" decoding="async">
			<span v-else :class="$style.packageIcon"><i class="ti ti-package"></i></span>
			<div :class="$style.heading">
				<span :class="$style.format">{{ i18n.ts._resonitePackage.format }}</span>
				<b class="_selectable" :class="$style.title" :title="title">{{ title }}</b>
				<span :class="$style.caption" :title="media.name">{{ media.name }} · {{ bytes(media.size, 1) }}</span>
			</div>
		</div>
		<p v-if="info?.description" class="_selectable" :class="$style.description">{{ info.description }}</p>
		<dl v-if="info" :class="$style.stats">
			<div><dt>{{ i18n.ts._resonitePackage.assets }}</dt><dd>{{ info.assetCount.toLocaleString() }}</dd></div>
			<div><dt>{{ i18n.ts._resonitePackage.slots }}</dt><dd>{{ info.slotCount?.toLocaleString() ?? i18n.ts._resonitePackage.unknown }}</dd></div>
			<div><dt>{{ i18n.ts._resonitePackage.components }}</dt><dd>{{ info.componentCount?.toLocaleString() ?? i18n.ts._resonitePackage.unknown }}</dd></div>
			<div><dt>{{ i18n.ts._resonitePackage.unpackedSize }}</dt><dd>{{ bytes(info.unpackedBytes, 1) }}</dd></div>
		</dl>
		<p v-if="status === 'unavailable'" :class="$style.caption" role="status">{{ i18n.ts._resonitePackage.unavailable }}</p>
		<div :class="$style.actions">
			<a v-if="downloadUrl" class="_button _buttonPrimary" :class="$style.action" :href="downloadUrl" :download="media.name" target="_blank" rel="noopener noreferrer" @click.stop><i class="ti ti-download"></i> {{ i18n.ts.download }}</a>
			<button v-if="!info && canInspect" type="button" class="_button" :class="[$style.action, $style.inspect]" :disabled="status === 'loading'" :aria-disabled="status === 'loading'" @click.stop="loadInfo">
				{{ status === 'loading' ? i18n.ts.loading : status === 'unavailable' ? i18n.ts.retry : i18n.ts._resonitePackage.showContents }}
			</button>
		</div>
	</template>
</div>
</template>

<script lang="ts" setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import bytes from '@/filters/bytes.js';
import { canRevealFile, shouldHideFileByDefault } from '@/utility/sensitive-file.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { packageDownloadUrl, packageInfoFromProperties, readResonitePackageInfo } from '@/utility/resonite-package.js';

const props = defineProps<{
	media: Misskey.entities.DriveFile;
	noteId?: string;
	ephemeral?: boolean;
	disableAnalysis?: boolean;
}>();

const hide = ref(shouldHideFileByDefault(props.media));
const info = shallowRef(packageInfoFromProperties(props.media.properties));
const status = ref<'idle' | 'loading' | 'unavailable'>('idle');
const title = computed(() => info.value?.name || props.media.name);
const downloadUrl = computed(() => packageDownloadUrl(props.media.url, props.ephemeral));
const canInspect = computed(() => !props.ephemeral && !props.disableAnalysis && !!(props.noteId || ($i && props.media.userId === $i.id)));
let generation = 0;
let active = true;
let disposed = false;
let controller: AbortController | undefined;

function cancel() {
	generation++;
	controller?.abort();
	controller = undefined;
	if (status.value === 'loading') status.value = 'idle';
}

watch([() => props.media, () => props.media.id, () => props.media.url, () => props.media.isSensitive, () => packageInfoFromProperties(props.media.properties), () => props.noteId, () => props.ephemeral, canInspect], () => {
	cancel();
	hide.value = shouldHideFileByDefault(props.media);
	info.value = packageInfoFromProperties(props.media.properties);
	status.value = 'idle';
}, { flush: 'sync' });

onDeactivated(() => { active = false; cancel(); });
onActivated(() => { active = true; });
onBeforeUnmount(() => { disposed = true; cancel(); });

async function reveal() {
	const current = generation;
	if (!await canRevealFile(props.media)) return;
	if (current === generation && active && !disposed) hide.value = false;
}

async function loadInfo() {
	if (hide.value || !canInspect.value || !active || disposed || status.value === 'loading') return;
	cancel();
	const current = generation;
	controller = new AbortController();
	status.value = 'loading';
	try {
		const result = await misskeyApi('drive/files/resonite-package', { fileId: props.media.id, ...(props.noteId ? { noteId: props.noteId } : {}) }, undefined, controller.signal);
		if (current !== generation || !active || disposed) return;
		info.value = readResonitePackageInfo(result);
		status.value = info.value ? 'idle' : 'unavailable';
	} catch {
		if (current === generation && active && !disposed) status.value = 'unavailable';
	} finally {
		if (current === generation) controller = undefined;
	}
}
</script>

<style lang="scss" module>
.root {
	container-type: inline-size;
	margin-top: 4px;
	padding: var(--MI-margin);
	border: 1px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
	color: var(--MI_THEME-fg);
	overflow: clip;
}

.header, .sensitive { display: flex; align-items: center; gap: 12px; min-width: 0; }
.sensitive { width: 100%; text-align: start; }
.icon { font-size: 1.6em; }
.heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.format { color: var(--MI_THEME-fg); opacity: 0.6; font-size: 0.75em; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1em; }
.caption { display: block; color: var(--MI_THEME-fg); opacity: 0.65; font-size: 0.8em; overflow-wrap: anywhere; }
.packageIcon { display: grid; place-items: center; flex: 0 0 48px; height: 48px; border-radius: var(--MI-radius); background: var(--MI_THEME-accentedBg); color: var(--MI_THEME-accent); font-size: 1.75em; }
.thumbnail { flex: 0 0 72px; border-radius: var(--MI-radius); object-fit: contain; background: var(--MI_THEME-panelHighlight); }
.description { margin: 12px 0 0; font-size: 0.85em; white-space: pre-wrap; overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin: 16px 0; padding-top: 12px; border-top: 1px solid var(--MI_THEME-divider); }
.stats dt { font-size: 0.75em; opacity: 0.65; }
.stats dd { margin: 3px 0 0; font-size: 1em; font-weight: 600; font-variant-numeric: tabular-nums; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px; border-radius: var(--MI-radius); font-size: 0.85em; }
.inspect { background: var(--MI_THEME-buttonBg); }
.action:focus-visible, .sensitive:focus-visible { outline: 2px solid var(--MI_THEME-focus); outline-offset: 3px; }

@container (min-width: 420px) {
	.stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
</style>
