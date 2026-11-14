<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<XColumn :menu="menu" :column="column" :isStacked="isStacked" :refresher="refreshColumn">
	<template #header>
		<i class="ti ti-device-tv"></i><span style="margin-left: 8px;">{{ column.name || column.timelineNameCache || i18n.ts._deck._columns.channel }}</span>
	</template>

	<div v-if="sharedChannel" class="_gaps_s">
		<MkInfo v-if="linkedChannelError" warn>{{ i18n.ts._gridspace.channelsUnavailable }} <MkButton @click="refreshColumn">{{ i18n.ts.retry }}</MkButton></MkInfo>
		<MkInfo v-if="linkedChannel?.isArchived" warn>{{ i18n.ts.thisChannelArchived }}</MkInfo>
		<MkGridspacePostForm v-else-if="$i && linkedChannel && prefer.r.showFixedPostFormInChannel.value" :key="sharedChannel" :channelId="sharedChannel" :channel="linkedChannel" embedded :autofocus="false" :class="$style.postForm" @sent="sharedTimeline?.refresh()"/>
		<div v-else-if="linkedChannel" style="padding: 10px 8px 0; text-align: center;">
			<MkButton primary gradate rounded inline small :aria-label="i18n.ts.note" @click="post"><i class="ti ti-pencil"></i></MkButton>
		</div>
		<MkGridspacePrivateNotes :key="sharedChannel" ref="sharedTimeline" :params="{ mode: 'channel', channelId: sharedChannel }" plain alwaysShow/>
	</div>
	<div v-else-if="column.channelId" class="_gaps_s">
		<MkPostForm v-if="$i && channel != null && channel.id === column.channelId && prefer.r.showFixedPostFormInChannel.value" :key="channel.id" :channel="channel" :class="$style.postForm" fixed :autofocus="false"/>
		<div v-else style="padding: 10px 8px 0; text-align: center;">
			<MkButton primary gradate rounded inline small @click="post"><i class="ti ti-pencil"></i></MkButton>
		</div>
		<MkStreamingNotesTimeline ref="timeline" src="channel" :channel="column.channelId"/>
	</div>
</XColumn>
</template>

<script lang="ts" setup>
import { computed, provide, ref, shallowRef, watch, useTemplateRef } from 'vue';
import MkGridspacePrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import MkGridspacePostForm from '@/components/MkGridspacePostForm.vue';
import { gridspacePost } from '@/utility/gridspace-post.js';
import * as Misskey from 'misskey-js';
import XColumn from './column.vue';
import type { Column } from '@/deck.js';
import type { MenuItem } from '@/types/menu.js';
import type { SoundStore } from '@/preferences/def.js';
import { updateColumn } from '@/deck.js';
import MkStreamingNotesTimeline from '@/components/MkStreamingNotesTimeline.vue';
import MkPostForm from '@/components/MkPostForm.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import * as os from '@/os.js';
import { getDeckChannelChoices, getSharedDeckChannelId } from '@/utility/deck-channel-choices.js';
import { DI } from '@/di.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';
import { soundSettingsButton } from '@/ui/deck/tl-note-notification.js';

const sharedTimeline = useTemplateRef('sharedTimeline');

const props = defineProps<{
	column: Column;
	isStacked: boolean;
}>();

const timeline = useTemplateRef('timeline');
const sharedChannel = computed(() => getSharedDeckChannelId(props.column.channelId));
const linkedChannel = shallowRef<Misskey.entities.GridspaceChannelsResponse['channels'][number]>();
const linkedChannelError = ref(false);
provide(DI.linkedChannel, computed(() => linkedChannel.value));
const channel = shallowRef<Misskey.entities.Channel>();
const soundSetting = ref<SoundStore>(props.column.soundSetting ?? { type: null, volume: 1 });

let metadataRequest = 0;
watch(sharedChannel, (id, _oldId, onCleanup) => {
	linkedChannel.value = undefined;
	linkedChannelError.value = false;
	onCleanup(() => { metadataRequest++; });
	if (!id) return;
	void loadLinkedChannel();
}, { immediate: true });

async function loadLinkedChannel() {
	const id = sharedChannel.value;
	if (!id) return;
	const request = ++metadataRequest;
	linkedChannelError.value = false;
	try {
		const result = await misskeyApi('gridspace/channels', { channelId: id });
		if (request !== metadataRequest || sharedChannel.value !== id) return;
		linkedChannel.value = result.channels.find(item => item.id === id);
		linkedChannelError.value = !linkedChannel.value;
		if (linkedChannel.value && linkedChannel.value.name !== props.column.timelineNameCache) {
			updateColumn(props.column.id, { timelineNameCache: linkedChannel.value.name });
		}
	} catch (error) {
		if (request !== metadataRequest || sharedChannel.value !== id) return;
		linkedChannelError.value = true;
		console.error('Failed to fetch paired channel:', error);
	}
}

async function refreshColumn() {
	if (sharedChannel.value) {
		await Promise.all([loadLinkedChannel(), sharedTimeline.value?.refresh()]);
	} else {
		await timeline.value?.reloadTimeline();
	}
}

watch([() => props.column.channelId, () => prefer.r.showFixedPostFormInChannel.value], ([newChannelId, showFixedPostForm], oldValue, onCleanup) => {
	if (sharedChannel.value) return;
	if (newChannelId == null) {
		// 設定値の変更だけで選択ダイアログを開かないよう、初回実行時か channelId が変わったときのみ
		// (複数ソースの immediate watcher では初回の oldValue が空配列になる)
		if (oldValue == null || !(0 in oldValue) || oldValue[0] !== newChannelId) setChannel();
		return;
	}
	if (!showFixedPostForm && props.column.name) return;
	if (channel.value != null && channel.value.id === newChannelId) return;

	let invalidated = false;
	onCleanup(() => {
		invalidated = true;
	});
	misskeyApi('channels/show', { channelId: newChannelId })
		.then(value => {
			if (invalidated || props.column.channelId !== newChannelId) return;
			if (value.name !== props.column.timelineNameCache) {
				updateColumn(props.column.id, { timelineNameCache: value.name });
			}
			channel.value = value;
		})
		.catch(err => {
			if (invalidated || props.column.channelId !== newChannelId) return;
			console.error('Failed to fetch channel:', err);
		});
}, { immediate: true });

watch(soundSetting, v => {
	updateColumn(props.column.id, { soundSetting: v });
});

async function setChannel() {
	const channels = await getDeckChannelChoices();
	const { canceled, result: chosenChannelId } = await os.select({
		title: i18n.ts.selectChannel,
		items: channels.map(x => ({
			value: x.id, label: x.label,
		})),
		default: channels.find(x => x.id === props.column.channelId)?.id,
	});
	if (canceled || chosenChannelId == null) return;
	const chosenChannel = channels.find(x => x.id === chosenChannelId)!;
	updateColumn(props.column.id, {
		channelId: chosenChannel.id,
		timelineNameCache: chosenChannel.name,
	});
}

async function post() {
	if (sharedChannel.value) {
		if (!linkedChannel.value || linkedChannel.value.isArchived) return;
		await gridspacePost({ channelId: sharedChannel.value, channel: linkedChannel.value }, () => { void sharedTimeline.value?.refresh(); });
		return;
	}
	if (props.column.channelId == null) return;
	if (!channel.value || channel.value.id !== props.column.channelId) {
		channel.value = await misskeyApi('channels/show', {
			channelId: props.column.channelId,
		});
	}

	os.post({
		channel: channel.value,
	});
}

const menu: MenuItem[] = [{
	icon: 'ti ti-pencil',
	text: i18n.ts.selectChannel,
	action: setChannel,
}, {
	icon: 'ti ti-bell',
	text: i18n.ts._deck.newNoteNotificationSettings,
	action: () => soundSettingsButton(soundSetting),
}];
</script>

<style module>
.postForm {
	background: var(--MI_THEME-panel);
	overflow: clip;
}
</style>
