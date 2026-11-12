<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<MkInfo v-if="timeline.error.value" warn role="status">{{ i18n.ts._gridspace.notificationUnavailable }} <button class="_textButton" @click="timeline.reload">{{ i18n.ts.retry }}</button></MkInfo>
	<MkLoading v-if="timeline.busy.value && timeline.rows.value.length === 0"/>
	<MkResult v-else-if="!timeline.error.value && timeline.rows.value.length === 0 && !timeline.hasMore.value" type="empty" :text="i18n.ts.noNotifications"/>
	<div v-for="row in timeline.rows.value" :key="row.members.map(n => n.key).join('|')" v-appear="() => timeline.seen(row)" :class="$style.item" :data-notification-key="row.key" :data-unread="!row.isRead">
		<div :class="$style.recipient"><i v-if="!row.isRead" class="ti ti-point-filled" :aria-label="i18n.ts.unread"></i>{{ i18n.tsx._gridspace.notificationRecipient({ host: host(row.origin) }) }}</div>
		<template v-if="row.source === 'local'">
			<MkNote v-if="['reply', 'quote', 'mention'].includes(row.local.type) && 'note' in row.local" :note="row.local.note" :withHardMute="true"/>
			<MkNotification v-else :notification="row.local" :withTime="true" :full="true"/>
		</template>
		<template v-else>
			<div :class="$style.summary">
				<strong>{{ notificationType(row.remote.type) }}</strong>
				<template v-for="member in row.members" :key="member.key">
					<template v-if="member.source === 'peer'">
						<MkA v-if="member.remote.user" :to="`/@${member.remote.user.username}@${member.remote.user.host}`">{{ member.remote.user.name || member.remote.user.username }}</MkA>
						<span v-if="member.remote.reaction">{{ member.remote.reaction }}</span>
					</template>
				</template>
				<MkTime :time="row.createdAt"/>
				<a :href="`${row.origin}/my/notifications`" target="_blank" rel="noopener noreferrer">{{ i18n.ts._gridspace.notificationOpenSource }}</a>
			</div>
			<p v-if="row.remote.body" :class="$style.body">{{ row.remote.body }}</p>
			<MkGridspacePrivateNote v-if="row.remote.note" :note="row.remote.note" @unavailable="timeline.reload"/>
		</template>
	</div>
	<button v-if="timeline.hasMore.value" v-appear="prefer.s.enableInfiniteScroll ? timeline.older : null" class="_button" :class="$style.more" :disabled="timeline.busy.value" @click="timeline.older">{{ i18n.ts.loadMore }}</button>
</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import MkInfo from '@/components/MkInfo.vue';
import MkNote from '@/components/MkNote.vue';
import MkNotification from '@/components/MkNotification.vue';
import MkGridspacePrivateNote from '@/components/MkGridspacePrivateNote.vue';
import { useGridspaceNotifications } from '@/utility/use-gridspace-notifications.js';

const props = defineProps<{ excludeTypes?: string[] | null }>();
const timeline = useGridspaceNotifications(computed(() => props.excludeTypes ?? []));
const host = (origin: string) => new URL(origin).host;

function notificationType(type: string) {
	return i18n.ts._notification._types[type as keyof typeof i18n.ts._notification._types] ?? i18n.ts.notifications;
}

defineExpose({ reload: timeline.reload, markDisplayed: timeline.markDisplayed });
</script>

<style module lang="scss">
.root { background: var(--MI_THEME-panel); }
.item { border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; }
.recipient { padding: 12px 24px 0; font-size: .8em; color: var(--MI_THEME-fgTransparentWeak); }
.summary { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; padding: 16px 24px; }
.body { padding: 0 24px 16px; white-space: pre-wrap; }
.more { width: 100%; padding: 16px; }
</style>
