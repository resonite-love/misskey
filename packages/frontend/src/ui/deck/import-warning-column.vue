<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<XColumn :column="column" :isStacked="isStacked" :menu="[]">
	<template #header>{{ column.name || column.type }}</template>
	<div class="_spacer _gaps_s">
		<MkInfo warn>{{ column.gridspaceImportError }}</MkInfo>
		<MkButton @click="configure">{{ i18n.ts.settings }}</MkButton>
	</div>
</XColumn>
</template>
<script setup lang="ts">
import XColumn from './column.vue';
import type { Column } from '@/deck.js';
import MkInfo from '@/components/MkInfo.vue';
import MkButton from '@/components/MkButton.vue';
import { updateColumn } from '@/deck.js';
import { i18n } from '@/i18n.js';
const props = defineProps<{ column: Column; isStacked: boolean }>();

function configure() {
	updateColumn(props.column.id, { gridspaceImportError: undefined, antennaId: undefined, listId: undefined, channelId: undefined, clipId: undefined, roleId: undefined });
}
</script>
