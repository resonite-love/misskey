<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkNotificationLayout :time="row.createdAt" :contentVisibilityAuto="false" data-gridspace-notification-card>
	<template #head>
		<div v-if="grouped" :class="[$style.icon, type === 'reaction' ? $style.icon_reactionGroup : $style.icon_renoteGroup]"><i :class="type === 'reaction' ? 'ti ti-plus' : 'ti ti-repeat'"></i></div>
		<MkAvatar v-else-if="avatar" :class="$style.icon" :user="avatar" link :preview="false"/>
		<img v-else-if="presentation?.icon" :class="[$style.icon, $style.icon_app]" :src="presentation.icon" alt="">
		<div :class="[$style.subIcon, $style[`t_${type}`]]">
			<MkReactionIcon v-if="type === 'reaction' && notice.reaction && !grouped" :reaction="notice.reaction" :emojiUrl="presentation?.reactionUrl ?? undefined" :noStyle="true" style="width: 100%; height: 100% !important; object-fit: contain;"/>
			<img v-else-if="type === 'roleAssigned' && presentation?.roleIcon" :src="presentation.roleIcon" alt="" style="width: 100%; height: 100%;">
			<i v-else-if="!grouped" :class="icon"></i>
		</div>
	</template>
	<template #header>
		<MkA v-if="presentation?.user && !grouped" :class="$style.headerName" :to="userPage(presentation.user)"><MkUserName :user="presentation.user"/></MkA>
		<span v-else>{{ title }}</span>
	</template>
	<MkA v-if="notice.note" :class="$style.text" :to="noteUrl" :title="summary"><Mfm :text="summary" :plain="true" :nowrap="true" :author="summaryNote?.author" :emojiUrls="summaryNote?.emojis ?? {}" :enableEmojiMenu="false"/></MkA>
	<span v-else-if="type === 'follow'" :class="$style.text">{{ i18n.ts.youGotNewFollower }}</span>
	<span v-else-if="type === 'receiveFollowRequest'" :class="$style.text">{{ i18n.ts.receiveFollowRequest }}</span>
	<template v-else-if="type === 'followRequestAccepted'">
		<span :class="$style.text">{{ i18n.ts.followRequestAccepted }}</span>
		<Mfm v-if="notice.body" :text="notice.body" :plain="true" :author="notice.user ?? undefined" :enableEmojiMenu="false"/>
	</template>
	<Mfm v-else-if="type === 'app' && notice.body" :text="notice.body" :enableEmojiMenu="false"/>
	<span v-else-if="type === 'roleAssigned'" :class="$style.text">{{ presentation?.roleName }}</span>
	<span v-else-if="type === 'chatRoomInvitationReceived'" :class="$style.text">{{ presentation?.roomName }}</span>
	<span v-else-if="type === 'test'" :class="$style.text">{{ i18n.ts._notification.notificationWillBeDisplayedLikeThis }}</span>
	<a v-if="sourcePath" :href="row.origin + sourcePath" target="_blank" rel="noopener noreferrer" :class="$style.text">{{ sourceLabel }}</a>
	<template v-if="type === 'receiveFollowRequest' && presentation?.followRequestId && !done">
		<MkFollowRequestActions v-if="presentation.canManageFollowRequest" :busy="acting" @decide="decide"/>
		<MkA v-else to="/settings/gridspace">{{ i18n.ts._gridspace.notificationFollowPermission }}</MkA>
		<p v-if="actionFailed" role="alert">{{ i18n.ts._gridspace.notificationFollowFailed }}</p>
	</template>
	<slot name="actions"></slot>
	<div v-if="grouped">
		<div v-for="member in peerMembers" :key="member.key" :class="$style.reactionsItem">
			<MkAvatar v-if="member.remote.presentation?.user" :class="$style.reactionsItemAvatar" :user="member.remote.presentation.user" link :preview="false"/>
			<div v-if="member.remote.reaction" :class="$style.reactionsItemReaction"><MkReactionIcon :reaction="member.remote.reaction" :emojiUrl="member.remote.presentation?.reactionUrl ?? undefined" :noStyle="true" style="width: 100%; height: 100% !important; object-fit: contain;"/></div>
		</div>
	</div>
</MkNotificationLayout>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { userPage } from '@@/js/user.js';
import type { NotificationGroup } from '@/utility/use-gridspace-notifications.js';
import MkFollowRequestActions from '@/components/MkFollowRequestActions.vue';
import MkNotificationLayout from '@/components/MkNotificationLayout.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import $style from '@/components/notification.module.scss';
import { i18n } from '@/i18n.js';

const props = defineProps<{ row: NotificationGroup & { source: 'peer' } }>();
const acting = ref(false);
const done = ref(false);
const actionFailed = ref(false);
watch(() => props.row.id, () => { done.value = false; actionFailed.value = false; });

async function decide(accept: boolean) {
	if (acting.value || !presentation.value?.followRequestId || !presentation.value.canManageFollowRequest) return;
	acting.value = true; actionFailed.value = false;
	try {
		await misskeyApi('gridspace/notifications/follow-request', { notificationId: props.row.id, followRequestId: presentation.value.followRequestId, accept }, undefined, AbortSignal.timeout(15000));
		done.value = true;
	} catch { actionFailed.value = true; } finally { acting.value = false; }
}

const notice = computed(() => props.row.remote);
const presentation = computed(() => notice.value.presentation);
const type = computed(() => notice.value.type);
const peerMembers = computed(() => props.row.members.filter(n => n.source === 'peer'));
const grouped = computed(() => peerMembers.value.length > 1);
const avatar = computed(() => type.value === 'app' ? null : presentation.value?.user ?? presentation.value?.noteUser ?? presentation.value?.recipient);
const title = computed(() => {
	if (grouped.value) {
		const n = new Set(peerMembers.value.map(member => member.remote.user?.uri ?? member.id)).size;
		return type.value === 'reaction' ? i18n.tsx._notification.reactedBySomeUsers({ n }) : i18n.tsx._notification.renotedBySomeUsers({ n });
	}
	if (type.value === 'test') return i18n.ts._notification.testNotification;
	if (type.value === 'exportCompleted') {
		const names: Record<string, string> = { antenna: i18n.ts.antennas, blocking: i18n.ts.blockedUsers, clip: i18n.ts.clips, customEmoji: i18n.ts.customEmojis, favorite: i18n.ts.favorites, following: i18n.ts.following, muting: i18n.ts.mutedUsers, note: i18n.ts.notes, userList: i18n.ts.lists };
		return i18n.tsx._notification.exportOfXCompleted({ x: names[presentation.value?.exportedEntity ?? ''] ?? i18n.ts.export });
	}
	if (type.value === 'app') return presentation.value?.header ?? i18n.ts.notifications;
	const titles: Record<string, string> = { pollEnded: i18n.ts._notification.pollEnded, scheduledNotePosted: i18n.ts._notification.scheduledNotePosted, scheduledNotePostFailed: i18n.ts._notification.scheduledNotePostFailed, roleAssigned: i18n.ts._notification.roleAssigned, achievementEarned: i18n.ts._notification.achievementEarned, note: i18n.ts._notification.newNote, login: i18n.ts._notification.login, createToken: i18n.ts._notification.createToken, chatRoomInvitationReceived: i18n.ts._notification.chatRoomInvitationReceived };
	if (titles[type.value]) return titles[type.value];
	return i18n.ts._notification._types[type.value as keyof typeof i18n.ts._notification._types] ?? i18n.ts.notifications;
});
const icon = computed(() => ({ follow: 'ti ti-plus', receiveFollowRequest: 'ti ti-clock', followRequestAccepted: 'ti ti-check', renote: 'ti ti-repeat', reply: 'ti ti-arrow-back-up', mention: 'ti ti-at', quote: 'ti ti-quote', pollEnded: 'ti ti-chart-arrows', scheduledNotePosted: 'ti ti-send', scheduledNotePostFailed: 'ti ti-alert-triangle', achievementEarned: 'ti ti-medal', exportCompleted: 'ti ti-archive', login: 'ti ti-login-2', createToken: 'ti ti-key', chatRoomInvitationReceived: 'ti ti-messages', roleAssigned: 'ti ti-badges' }[type.value] ?? 'ti ti-bell'));
const noteUrl = computed(() => `/gridspace/private?noteId=${notice.value.note?.id}${notice.value.note?.channelId ? `&channelId=${notice.value.note.channelId}` : ''}`);
const summaryNote = computed(() => type.value === 'renote' ? notice.value.renote : notice.value.note);
const summary = computed(() => {
	const note = summaryNote.value;
	if (!note) return i18n.ts.invisibleNote;
	return (note.cw ?? note.text ?? '') + (note.files.length ? ` (${i18n.tsx.withNFiles({ n: note.files.length })})` : '') + (note.poll ? ` (${i18n.ts.poll})` : '');
});
const sourcePath = computed(() => {
	if (type.value === 'achievementEarned') return '/my/achievements';
	if (type.value === 'exportCompleted' && presentation.value?.fileId) return `/my/drive/file/${encodeURIComponent(presentation.value.fileId)}`;
	if (type.value === 'createToken') return '/settings/apps';
	if (type.value === 'chatRoomInvitationReceived') return '/chat';
	if (type.value === 'receiveFollowRequest') return '/my/follow-requests';
	return null;
});
const sourceLabel = computed(() => {
	if (type.value === 'achievementEarned') return i18n.ts._achievements._types[`_${presentation.value?.achievement}` as keyof typeof i18n.ts._achievements._types]?.title ?? i18n.ts._gridspace.notificationOpenSource;
	if (type.value === 'exportCompleted') return i18n.ts.showFile;
	if (type.value === 'createToken') return i18n.ts.manageAccessTokens;
	return i18n.ts._gridspace.notificationOpenSource;
});
</script>
