<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkPagination :paginator="paginator" :direction="direction" :autoLoad="autoLoad" :pullToRefresh="pullToRefresh" :withControl="withControl" :forceDisableInfiniteScroll="forceDisableInfiniteScroll">
	<template #empty><MkResult type="empty" :text="i18n.ts.noNotes"/></template>

	<template #default="{ items: notes }">
		<MkNoteListLayout :items="notes" :getKey="note => note.id" :getDate="note => note.createdAt" :noGap="noGap">
			<template #default="{ item: note }"><MkNote :note="note" :withHardMute="true"/></template>
			<template #after="{ item: note }"><div v-if="note._shouldInsertAd_" :class="[$style.ad, { [$style.noGap]: noGap }]"><MkAd :preferForms="['horizontal', 'horizontal-big']"/></div></template>
		</MkNoteListLayout>
	</template>
</MkPagination>
</template>

<script lang="ts" setup generic="T extends IPaginator<Misskey.entities.Note>">
import * as Misskey from 'misskey-js';
import type { MkPaginationOptions } from '@/components/MkPagination.vue';
import type { IPaginator } from '@/utility/paginator.js';
import MkNoteListLayout from '@/components/MkNoteListLayout.vue';
import MkNote from '@/components/MkNote.vue';
import MkPagination from '@/components/MkPagination.vue';
import { i18n } from '@/i18n.js';
import { useGlobalEvent } from '@/events.js';

const props = withDefaults(defineProps<MkPaginationOptions & {
	paginator: T;
	noGap?: boolean;
}>(), {
	autoLoad: true,
	direction: 'down',
	pullToRefresh: true,
	withControl: true,
	forceDisableInfiniteScroll: false,
});

useGlobalEvent('noteDeleted', (noteId) => {
	props.paginator.removeItem(noteId);
});

function reload() {
	return props.paginator.reload();
}

defineExpose({
	reload,
});
</script>

<style lang="scss" module>
.ad.noGap { padding: 8px; background-image: repeating-linear-gradient(45deg, transparent, transparent 8px, var(--MI_THEME-bg) 8px, var(--MI_THEME-bg) 14px); border-bottom: solid .5px var(--MI_THEME-divider); }
.ad:empty { display: none; }
</style>
