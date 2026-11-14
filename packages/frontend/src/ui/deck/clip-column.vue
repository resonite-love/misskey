<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<XColumn :menu="menu" :column="column" :isStacked="isStacked" :refresher="async () => { await (sharedClip ? sharedTimeline?.reload() : paginator.reload()) }">
	<template #header>
		<i class="ti ti-paperclip"></i><span style="margin-left: 8px;">{{ column.name || column.timelineNameCache || i18n.ts._deck._columns.clip }}</span>
	</template>

	<MkResult v-if="notFound" type="notFound"/>
	<MkGridspaceNoteList v-else-if="sharedClip" ref="sharedTimeline" :source="{ kind: 'clip', clipId: sharedClip.id }"/>
	<MkNotesTimeline v-else-if="column.clipId" :paginator="paginator" :withControl="false" :noGap="true"/>
</XColumn>
</template>

<script lang="ts" setup>
import { computed, markRaw, onMounted, onUnmounted, provide, ref, shallowRef, watch, useTemplateRef } from 'vue';
import * as Misskey from 'misskey-js';
import XColumn from './column.vue';
import type { Column } from '@/deck.js';
import type { MenuItem } from '@/types/menu.js';
import { updateColumn } from '@/deck.js';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { clipsCache, favoritedClipsCache } from '@/cache.js';
import { useStream } from '@/stream.js';
import { $i } from '@/i.js';
import { Paginator } from '@/utility/paginator.js';
import { getClipColumnReloadDelayMs } from './clip-column.js';
import MkGridspaceNoteList from '@/components/MkGridspaceNoteList.vue';
import { parseManagedId } from '@/utility/gridspace-managed-api.js';
import { loadClipMenu } from '@/utility/clip-menu.js';

const sharedTimeline = useTemplateRef('sharedTimeline');

const props = defineProps<{
	column: Column;
	isStacked: boolean;
}>();

const clip = shallowRef<Misskey.entities.Clip | null>(null);
const notFound = ref(false);
const sharedClip = computed(() => parseManagedId(props.column.clipId));

provide('currentClip', clip);

const paginator = markRaw(new Paginator('clips/notes', {
	limit: 10,
	canSearch: true,
	computedParams: computed(() => props.column.clipId ? { clipId: props.column.clipId } : null),
}));

let connection: Misskey.IChannelConnection<Misskey.Channels['clip']> | null = null;

// 同じクリップを大勢が購読していると、更新の度に全員が同時にreloadしリクエストがスパイクしうるため、
// 受信直後ではなくランダムな遅延を挟んでからreloadし、着火タイミングを分散させる
let reloadTimer: number | null = null;

function scheduleReload() {
	if (reloadTimer != null) return;
	const delay = getClipColumnReloadDelayMs(clip.value?.userId, $i?.id);
	if (delay === 0) {
		paginator.reload();
		return;
	}

	reloadTimer = window.setTimeout(() => {
		reloadTimer = null;
		paginator.reload();
	}, delay);
}

function cancelScheduledReload() {
	if (reloadTimer != null) {
		window.clearTimeout(reloadTimer);
		reloadTimer = null;
	}
}

function disconnectChannel() {
	cancelScheduledReload();
	if (connection) {
		connection.dispose();
		connection = null;
	}
}

function connectChannel() {
	disconnectChannel();
	if (props.column.clipId == null || sharedClip.value) return;
	connection = useStream().useChannel('clip', {
		clipId: props.column.clipId,
	});
	connection.on('updated', () => {
		scheduleReload();
	});
	connection.on('deleted', () => {
		cancelScheduledReload();
		clip.value = null;
		notFound.value = true;
	});
}

watch(() => props.column.clipId, async (clipId, _previousClipId, onCleanup) => {
	let active = true;
	onCleanup(() => { active = false; });
	connectChannel();
	clip.value = null;
	notFound.value = false;

	if (clipId == null) return;

	try {
		const fetchedClip = sharedClip.value
			? (await misskeyApi('gridspace/managed-resource', { kind: 'clip', action: 'reference', id: sharedClip.value.id })).item as unknown as Misskey.entities.Clip
			: await misskeyApi('clips/show', { clipId });
		if (!active || props.column.clipId !== clipId) return;
		clip.value = fetchedClip;
		notFound.value = false;
		if (props.column.timelineNameCache == null) {
			updateColumn(props.column.id, { timelineNameCache: fetchedClip.name });
		}
	} catch {
		if (!active || props.column.clipId !== clipId) return;
		clip.value = null;
		notFound.value = true;
	}
}, { immediate: true });

onMounted(() => {
	if (props.column.clipId == null) {
		setClip();
	}
});

onUnmounted(() => {
	disconnectChannel();
});

async function setClip() {
	const [myClips, favoritedClips] = await Promise.all([
		loadClipMenu((path, data) => misskeyApi(path as keyof Misskey.Endpoints, data)).then(result => result.clips),
		favoritedClipsCache.fetch(),
	]);
	const otherFavoritedClips = favoritedClips.filter(x => !myClips.some(y => y.id === x.id));

	const { canceled, result: chosenClipId } = await os.select({
		title: i18n.ts.selectClip,
		items: [
			(myClips.length > 0 ? {
				type: 'group' as const,
				label: i18n.ts.clips,
				items: myClips.map(x => ({ value: x.id, label: x.name })),
			} : undefined),
			(otherFavoritedClips.length > 0 ? {
				type: 'group' as const,
				label: i18n.ts.favorites,
				items: otherFavoritedClips.map(x => ({ value: x.id, label: x.name })),
			} : undefined),
		],
		default: props.column.clipId,
	});
	if (canceled || chosenClipId == null) return;

	const chosenClip = [...myClips, ...favoritedClips].find(x => x.id === chosenClipId)!;
	clip.value = chosenClip;
	notFound.value = false;
	updateColumn(props.column.id, {
		clipId: chosenClip.id,
		timelineNameCache: chosenClip.name,
	});
}

function openClip() {
	if (props.column.clipId == null) return;
	os.pageWindow(sharedClip.value ? `/clips/${sharedClip.value.id}/linked` : '/clips/' + props.column.clipId);
}

const menu: MenuItem[] = [
	{
		icon: 'ti ti-pencil',
		text: i18n.ts.selectClip,
		action: setClip,
	},
	{
		icon: 'ti ti-paperclip',
		text: i18n.ts.show,
		action: openClip,
	},
];
</script>
