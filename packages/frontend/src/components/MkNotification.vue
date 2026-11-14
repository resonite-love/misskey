<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkNotificationLayout :contentVisibilityAuto="contentVisibilityAuto" :time="withTime ? notification.createdAt : undefined">
	<template #head>
		<MkAvatar v-if="['pollEnded', 'note'].includes(notification.type) && 'note' in notification" :class="$style.icon" :user="notification.note.user" link preview/>
		<MkAvatar v-else-if="['roleAssigned', 'achievementEarned', 'exportCompleted', 'login', 'createToken', 'scheduledNotePosted', 'scheduledNotePostFailed'].includes(notification.type)" :class="$style.icon" :user="$i" link preview/>
		<div v-else-if="notification.type === 'reaction:grouped' && notification.note.reactionAcceptance === 'likeOnly'" :class="[$style.icon, $style.icon_reactionGroupHeart]"><i class="ti ti-heart" style="line-height: 1;"></i></div>
		<div v-else-if="notification.type === 'reaction:grouped'" :class="[$style.icon, $style.icon_reactionGroup]"><i class="ti ti-plus" style="line-height: 1;"></i></div>
		<div v-else-if="notification.type === 'renote:grouped'" :class="[$style.icon, $style.icon_renoteGroup]"><i class="ti ti-repeat" style="line-height: 1;"></i></div>
		<MkAvatar v-else-if="'user' in notification" :class="$style.icon" :user="notification.user" link preview/>
		<img v-else-if="'icon' in notification && notification.icon != null" :class="[$style.icon, $style.icon_app]" :src="notification.icon" alt=""/>
		<div
			:class="[$style.subIcon, {
				[$style.t_follow]: notification.type === 'follow',
				[$style.t_followRequestAccepted]: notification.type === 'followRequestAccepted',
				[$style.t_receiveFollowRequest]: notification.type === 'receiveFollowRequest',
				[$style.t_renote]: notification.type === 'renote',
				[$style.t_reply]: notification.type === 'reply',
				[$style.t_mention]: notification.type === 'mention',
				[$style.t_quote]: notification.type === 'quote',
				[$style.t_pollEnded]: notification.type === 'pollEnded',
				[$style.t_scheduledNotePosted]: notification.type === 'scheduledNotePosted',
				[$style.t_scheduledNotePostFailed]: notification.type === 'scheduledNotePostFailed',
				[$style.t_achievementEarned]: notification.type === 'achievementEarned',
				[$style.t_exportCompleted]: notification.type === 'exportCompleted',
				[$style.t_login]: notification.type === 'login',
				[$style.t_createToken]: notification.type === 'createToken',
				[$style.t_chatRoomInvitationReceived]: notification.type === 'chatRoomInvitationReceived',
				[$style.t_roleAssigned]: notification.type === 'roleAssigned' && notification.role.iconUrl == null,
			}]"
		>
			<i v-if="notification.type === 'follow'" class="ti ti-plus"></i>
			<i v-else-if="notification.type === 'receiveFollowRequest'" class="ti ti-clock"></i>
			<i v-else-if="notification.type === 'followRequestAccepted'" class="ti ti-check"></i>
			<i v-else-if="notification.type === 'renote'" class="ti ti-repeat"></i>
			<i v-else-if="notification.type === 'reply'" class="ti ti-arrow-back-up"></i>
			<i v-else-if="notification.type === 'mention'" class="ti ti-at"></i>
			<i v-else-if="notification.type === 'quote'" class="ti ti-quote"></i>
			<i v-else-if="notification.type === 'pollEnded'" class="ti ti-chart-arrows"></i>
			<i v-else-if="notification.type === 'scheduledNotePosted'" class="ti ti-send"></i>
			<i v-else-if="notification.type === 'scheduledNotePostFailed'" class="ti ti-alert-triangle"></i>
			<i v-else-if="notification.type === 'achievementEarned'" class="ti ti-medal"></i>
			<i v-else-if="notification.type === 'exportCompleted'" class="ti ti-archive"></i>
			<i v-else-if="notification.type === 'login'" class="ti ti-login-2"></i>
			<i v-else-if="notification.type === 'createToken'" class="ti ti-key"></i>
			<i v-else-if="notification.type === 'chatRoomInvitationReceived'" class="ti ti-messages"></i>
			<template v-else-if="notification.type === 'roleAssigned'">
				<img v-if="notification.role.iconUrl" style="height: 1.3em; vertical-align: -22%;" :src="notification.role.iconUrl" alt=""/>
				<i v-else class="ti ti-badges"></i>
			</template>
			<MkReactionIcon
				v-else-if="notification.type === 'reaction'"
				:withTooltip="true"
				:reaction="notification.reaction.replace(/^:(\w+):$/, ':$1@.:')"
				:noStyle="true"
				style="width: 100%; height: 100% !important; object-fit: contain;"
			/>
		</div>
	</template>
	<template #header>
		<span v-if="notification.type === 'pollEnded'">{{ i18n.ts._notification.pollEnded }}</span>
		<span v-else-if="notification.type === 'scheduledNotePosted'">{{ i18n.ts._notification.scheduledNotePosted }}</span>
		<span v-else-if="notification.type === 'scheduledNotePostFailed'">{{ i18n.ts._notification.scheduledNotePostFailed }}</span>
		<span v-else-if="notification.type === 'note'">{{ i18n.ts._notification.newNote }}: <MkUserName :user="notification.note.user"/></span>
		<span v-else-if="notification.type === 'roleAssigned'">{{ i18n.ts._notification.roleAssigned }}</span>
		<span v-else-if="notification.type === 'chatRoomInvitationReceived'">{{ i18n.ts._notification.chatRoomInvitationReceived }}</span>
		<span v-else-if="notification.type === 'achievementEarned'">{{ i18n.ts._notification.achievementEarned }}</span>
		<span v-else-if="notification.type === 'login'">{{ i18n.ts._notification.login }}</span>
		<span v-else-if="notification.type === 'createToken'">{{ i18n.ts._notification.createToken }}</span>
		<span v-else-if="notification.type === 'test'">{{ i18n.ts._notification.testNotification }}</span>
		<span v-else-if="notification.type === 'exportCompleted'">{{ i18n.tsx._notification.exportOfXCompleted({ x: exportEntityName[notification.exportedEntity] }) }}</span>
		<MkA v-else-if="notification.type === 'follow' || notification.type === 'mention' || notification.type === 'reply' || notification.type === 'renote' || notification.type === 'quote' || notification.type === 'reaction' || notification.type === 'receiveFollowRequest' || notification.type === 'followRequestAccepted'" v-user-preview="notification.user.id" :class="$style.headerName" :to="userPage(notification.user)"><MkUserName :user="notification.user"/></MkA>
		<span v-else-if="notification.type === 'reaction:grouped' && notification.note.reactionAcceptance === 'likeOnly'">{{ i18n.tsx._notification.likedBySomeUsers({ n: getActualReactedUsersCount(notification) }) }}</span>
		<span v-else-if="notification.type === 'reaction:grouped'">{{ i18n.tsx._notification.reactedBySomeUsers({ n: getActualReactedUsersCount(notification) }) }}</span>
		<span v-else-if="notification.type === 'renote:grouped'">{{ i18n.tsx._notification.renotedBySomeUsers({ n: notification.users.length }) }}</span>
		<span v-else-if="notification.type === 'app'">{{ notification.header }}</span>
	</template>
	<div>
		<MkA v-if="notification.type === 'reaction' || notification.type === 'reaction:grouped'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<i class="ti ti-quote" :class="$style.quote"></i>
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
			<i class="ti ti-quote" :class="$style.quote"></i>
		</MkA>
		<MkA v-else-if="notification.type === 'renote' || notification.type === 'renote:grouped'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note.renote)">
			<i class="ti ti-quote" :class="$style.quote"></i>
			<Mfm :text="getNoteSummary(notification.note.renote)" :plain="true" :nowrap="true" :author="notification.note.renote?.user"/>
			<i class="ti ti-quote" :class="$style.quote"></i>
		</MkA>
		<MkA v-else-if="notification.type === 'reply'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
		</MkA>
		<MkA v-else-if="notification.type === 'mention'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
		</MkA>
		<MkA v-else-if="notification.type === 'quote'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
		</MkA>
		<MkA v-else-if="notification.type === 'note'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
		</MkA>
		<MkA v-else-if="notification.type === 'pollEnded'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<i class="ti ti-quote" :class="$style.quote"></i>
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
			<i class="ti ti-quote" :class="$style.quote"></i>
		</MkA>
		<MkA v-else-if="notification.type === 'scheduledNotePosted'" :class="$style.text" :to="notePage(notification.note)" :title="getNoteSummary(notification.note)">
			<i class="ti ti-quote" :class="$style.quote"></i>
			<Mfm :text="getNoteSummary(notification.note)" :plain="true" :nowrap="true" :author="notification.note.user"/>
			<i class="ti ti-quote" :class="$style.quote"></i>
		</MkA>
		<div v-else-if="notification.type === 'roleAssigned'" :class="$style.text">
			{{ notification.role.name }}
		</div>
		<div v-else-if="notification.type === 'chatRoomInvitationReceived'" :class="$style.text">
			{{ notification.invitation.room.name }}
		</div>
		<MkA v-else-if="notification.type === 'achievementEarned'" :class="$style.text" to="/my/achievements">
			{{ i18n.ts._achievements._types[`_${notification.achievement}`].title }}
		</MkA>
		<MkA v-else-if="notification.type === 'exportCompleted'" :class="$style.text" :to="`/my/drive/file/${notification.fileId}`">
			{{ i18n.ts.showFile }}
		</MkA>
		<MkA v-else-if="notification.type === 'createToken'" :class="$style.text" to="/settings/apps">
			<Mfm :text="i18n.tsx._notification.createTokenDescription({ text: i18n.ts.manageAccessTokens })"/>
		</MkA>
		<template v-else-if="notification.type === 'follow'">
			<span :class="$style.text" style="opacity: 0.6;">{{ i18n.ts.youGotNewFollower }}</span>
		</template>
		<template v-else-if="notification.type === 'followRequestAccepted'">
			<div :class="$style.text" style="opacity: 0.6;">{{ i18n.ts.followRequestAccepted }}</div>
			<div v-if="notification.message" :class="$style.text" style="opacity: 0.6; font-style: oblique;">
				<i class="ti ti-quote" :class="$style.quote"></i>
				<Mfm :text="notification.message" :author="notification.user" :plain="true" :nowrap="true"/>
				<i class="ti ti-quote" :class="$style.quote"></i>
			</div>
		</template>
		<template v-else-if="notification.type === 'receiveFollowRequest'">
			<span :class="$style.text" style="opacity: 0.6;">{{ i18n.ts.receiveFollowRequest }}</span>
			<MkFollowRequestActions v-if="full && !followRequestDone" :busy="followRequestBusy" @decide="decideFollowRequest"/>
		</template>
		<span v-else-if="notification.type === 'test'" :class="$style.text">{{ i18n.ts._notification.notificationWillBeDisplayedLikeThis }}</span>
		<span v-else-if="notification.type === 'app'" :class="$style.text">
			<Mfm :text="notification.body" :nowrap="false"/>
		</span>

		<div v-if="notification.type === 'reaction:grouped'">
			<div v-for="reaction of notification.reactions" :key="reaction.user.id + reaction.reaction" :class="$style.reactionsItem">
				<MkAvatar :class="$style.reactionsItemAvatar" :user="reaction.user" link preview/>
				<div :class="$style.reactionsItemReaction">
					<MkReactionIcon
						:withTooltip="true"
						:reaction="reaction.reaction.replace(/^:(\w+):$/, ':$1@.:')"
						:noStyle="true"
						style="width: 100%; height: 100% !important; object-fit: contain;"
					/>
				</div>
			</div>
		</div>
		<div v-else-if="notification.type === 'renote:grouped'">
			<div v-for="user of notification.users" :key="user.id" :class="$style.reactionsItem">
				<MkAvatar :class="$style.reactionsItemAvatar" :user="user" link preview/>
			</div>
		</div>
	</div>
</MkNotificationLayout>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import * as Misskey from 'misskey-js';
import { notePage } from '@@/js/note.js';
import { userPage } from '@@/js/user.js';
import * as os from '@/os.js';
import MkFollowRequestActions from '@/components/MkFollowRequestActions.vue';
import MkNotificationLayout from '@/components/MkNotificationLayout.vue';
import $style from '@/components/notification.module.scss';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import { getNoteSummary } from '@/utility/get-note-summary.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { ensureSignin } from '@/i.js';

const $i = ensureSignin();

const props = withDefaults(defineProps<{
	notification: Misskey.entities.Notification;
	withTime?: boolean;
	full?: boolean;
	contentVisibilityAuto?: boolean;
}>(), {
	withTime: false,
	full: false,
	contentVisibilityAuto: true,
});

type ExportCompletedNotification = Misskey.entities.Notification & { type: 'exportCompleted' };

const exportEntityName = {
	antenna: i18n.ts.antennas,
	blocking: i18n.ts.blockedUsers,
	clip: i18n.ts.clips,
	customEmoji: i18n.ts.customEmojis,
	favorite: i18n.ts.favorites,
	following: i18n.ts.following,
	muting: i18n.ts.mutedUsers,
	note: i18n.ts.notes,
	userList: i18n.ts.lists,
} as const satisfies Record<ExportCompletedNotification['exportedEntity'], string>;

const followRequestDone = ref(false);

const followRequestBusy = ref(false);

async function decideFollowRequest(accept: boolean) {
	if (!('user' in props.notification) || followRequestBusy.value) return;
	followRequestBusy.value = true;
	try {
		await misskeyApi(accept ? 'following/requests/accept' : 'following/requests/reject', { userId: props.notification.user.id });
		followRequestDone.value = true;
	} catch { os.alert({ type: 'error', text: i18n.ts.error }); } finally { followRequestBusy.value = false; }
}

function getActualReactedUsersCount(notification: Misskey.entities.Notification) {
	if (notification.type !== 'reaction:grouped') return 0;
	return new Set(notification.reactions.map((reaction) => reaction.user.id)).size;
}
</script>

