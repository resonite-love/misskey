<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" :refresher="timeline.reload">
<div ref="rootEl" :class="$style.notifications">
	<MkInfo v-if="timeline.error.value" warn role="status">{{ i18n.ts._gridspace.notificationUnavailable }} <button class="_textButton" @click="timeline.reload">{{ i18n.ts.retry }}</button></MkInfo>
	<MkInfo v-if="timeline.readError.value" warn role="status">{{ i18n.ts._gridspace.notificationReadFailed }}</MkInfo>
	<MkLoading v-if="timeline.busy.value && timeline.rows.value.length === 0"/>
	<MkResult v-else-if="!timeline.error.value && timeline.rows.value.length === 0 && !timeline.hasMore.value" type="empty" :text="i18n.ts.noNotifications"/>
	<button v-if="timeline.queued.value" class="_buttonPrimary" :class="ui.new" @click="releaseQueue">{{ i18n.ts._gridspace.notificationNew }}</button>
	<component :is="prefer.s.animation ? TransitionGroup : 'div'" :enterActiveClass="$style.transition_x_enterActive" :enterFromClass="$style.transition_x_enterFrom" :moveClass="$style.transition_x_move" tag="div" @beforeLeave="clearPeerRow">
		<MkGridspaceNotificationRow v-for="(row, i) in timeline.rows.value" :key="row.key" :row="row" :class="$style.item" :data-notification-key="row.key" :data-unread="!row.isRead" :data-scroll-anchor="row.key" @seen="timeline.seen">
			<div v-if="i > 0 && isSeparatorNeeded(timeline.rows.value[i - 1].createdAt, row.createdAt)" :class="$style.date">
				<span><i class="ti ti-chevron-up"></i> {{ getSeparatorInfo(timeline.rows.value[i - 1].createdAt, row.createdAt)?.prevText }}</span>
				<span>{{ getSeparatorInfo(timeline.rows.value[i - 1].createdAt, row.createdAt)?.nextText }} <i class="ti ti-chevron-down"></i></span>
			</div>
			<div :class="ui.recipient"><i v-if="!row.isRead" class="ti ti-point-filled" :aria-label="i18n.ts.unread"></i>{{ i18n.tsx._gridspace.notificationRecipient({ host: host(row.origin) }) }}</div>
			<template v-if="row.source === 'local'">
				<MkNote v-if="['reply', 'quote', 'mention'].includes(row.local.type) && 'note' in row.local" :class="$style.content" :note="row.local.note" :withHardMute="true"/>
				<MkNotification v-else :class="$style.content" :notification="row.local" :withTime="true" :full="true"/>
			</template>
			<template v-else>
				<MkGridspacePrivateNote v-if="['reply', 'quote', 'mention'].includes(row.remote.type) && row.remote.note" :note="row.remote.note" @unavailable="timeline.reload"/>
				<MkGridspaceNotification v-else :row="row"/>
			</template>
		</MkGridspaceNotificationRow>
	</component>
	<button v-if="timeline.hasMore.value" v-appear="prefer.s.enableInfiniteScroll ? timeline.older : null" class="_button" :class="$style.more" :disabled="timeline.busy.value" @click="timeline.older">{{ i18n.ts.loadMore }}</button>
</div>
</component>
</template>

<script setup lang="ts">
import { computed, TransitionGroup, useTemplateRef, watch, onBeforeUnmount } from 'vue';
import { getScrollContainer, scrollToTop } from '@@/js/scroll.js';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import MkGridspaceNotification from '@/components/MkGridspaceNotification.vue';
import MkGridspaceNotificationRow from '@/components/MkGridspaceNotificationRow.vue';
import { isSeparatorNeeded, getSeparatorInfo } from '@/utility/timeline-date-separate.js';
import $style from '@/components/notification-timeline.module.scss';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import MkInfo from '@/components/MkInfo.vue';
import MkNote from '@/components/MkNote.vue';
import MkNotification from '@/components/MkNotification.vue';
import MkGridspacePrivateNote from '@/components/MkGridspacePrivateNote.vue';
import { useGridspaceNotifications } from '@/utility/use-gridspace-notifications.js';

const props = defineProps<{ excludeTypes?: string[] | null }>();
const rootEl = useTemplateRef('rootEl');
let scrollContainer: HTMLElement | null = null;

function isTop() { return !rootEl.value || !scrollContainer || scrollContainer.scrollTop <= rootEl.value.offsetTop - scrollContainer.offsetTop; }

const timeline = useGridspaceNotifications(computed(() => props.excludeTypes ?? []), isTop);

function releaseQueue() { timeline.releaseQueue(); if (rootEl.value) scrollToTop(rootEl.value); }

function onScroll() { if (isTop()) timeline.releaseQueue(); }

watch(rootEl, el => {
	if (!el || scrollContainer) return;
	scrollContainer = getScrollContainer(el);
	scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
});
onBeforeUnmount(() => scrollContainer?.removeEventListener('scroll', onScroll));

function clearPeerRow(el: Element) { if (el.hasAttribute('data-gridspace-peer-notification')) el.replaceChildren(); }

const host = (origin: string) => new URL(origin).host;

defineExpose({ reload: timeline.reload, markDisplayed: timeline.markDisplayed, markAll: timeline.markAll });
</script>

<style module="ui" lang="scss">
.recipient { padding: 8px 16px 0; font-size: .8em; color: var(--MI_THEME-fgTransparentWeak); }
.new { position: sticky; top: var(--MI-stickyTop, 0px); z-index: 2; display: block; margin: 8px auto; border-radius: var(--MI-radius); padding: 8px 16px; }
</style>
