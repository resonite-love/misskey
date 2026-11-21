<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div data-gridspace-reference-renote>
	<div :class="$style.header">
		<MkNoteChannel :channel="note.channel" :placements="!note.isHidden && note.multiNoteKind === 'root' ? note.channelPlacements : undefined" display="bar" compact/>
		<MkAvatar :user="note.user" :class="$style.avatar" link/>
		<i class="ti ti-repeat"></i>
		<I18n :src="i18n.ts.renotedBy" tag="span"><template #user><MkUserName :user="note.user"/></template></I18n>
		<button class="_button" :class="$style.time" :aria-label="i18n.ts.more" @click="emit('menu', $event)"><i class="ti ti-dots"></i> <MkTime :time="note.createdAt"/></button>
		<span v-if="note.visibility && note.visibility !== 'public'" :title="i18n.ts._visibility[note.visibility]"><i :class="note.visibility === 'home' ? 'ti ti-home' : note.visibility === 'specified' ? 'ti ti-mail' : 'ti ti-lock'"></i></span>
		<span v-if="note.localOnly" :title="i18n.ts._visibility.disableFederation"><i class="ti ti-rocket-off"></i></span>
	</div>
	<MkGridspaceNoteLinkPreview :url="note.gridspaceQuote!" fullNote :detailed="detailed"/>
</div>
</template>

<script setup lang="ts">
import type { entities } from 'misskey-js';
import MkGridspaceNoteLinkPreview from '@/components/MkGridspaceNoteLinkPreview.vue';
import MkNoteChannel from '@/components/MkNoteChannel.vue';
import { i18n } from '@/i18n.js';

type ReferenceNote = Pick<entities.Note, 'user' | 'createdAt' | 'gridspaceQuote'> &
	Partial<Pick<entities.Note, 'visibility' | 'localOnly' | 'multiNoteKind' | 'channelPlacements' | 'isHidden'>> &
	{ channel?: { id: string; name: string; color: string } | null };
defineProps<{ note: ReferenceNote; detailed?: boolean }>();
const emit = defineEmits<{ menu: [event: MouseEvent] }>();
</script>

<style lang="scss" module>
.header { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 16px 24px 0; color: var(--MI_THEME-renote); }
.avatar { width: 28px; height: 28px; }
.time { margin-left: auto; }
</style>
