<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps_s" data-gridspace-note-actions>
	<MkPoll v-if="compact && note.poll" :noteId="note.id" :choices="note.poll.choices.map(choice => ({ ...choice, isVoted: choice.isVoted === true }))" :multiple="note.poll.multiple" :expiresAt="note.poll.expiresAt" :emojiUrls="note.emojis ?? {}" :voteHandler="vote"/>
	<ul v-else-if="note.poll" :class="$style.choices">
		<li v-for="(choice, index) in note.poll.choices" :key="index">
			<Mfm :text="choice.text" :author="note.author" :emojiUrls="note.emojis ?? {}" :plain="true" :enableEmojiMenu="false"/>
			<span> — {{ choice.votes }} <i v-if="choice.isVoted" class="ti ti-check" :aria-label="i18n.ts._gridspace.actionVoted"></i></span>
			<MkButton v-if="info?.canInteract" small :disabled="busy || !canVote(index)" @click="act({ action: 'vote', choice: index })">{{ i18n.ts._poll.vote }}</MkButton>
		</li>
	</ul>
	<MkReactionsViewer :noteId="note.id" :reactions="note.reactions ?? {}" :reactionEmojis="note.reactionEmojis ?? {}" :myReaction="note.myReaction" :myReactions="note.myReactions" :extendedReactions="note.extendedReactions" :transport="reactionTransport" :reactionVersion="reactionRevision"/>
	<div v-if="selectedReaction" class="_gaps_s">
		<div v-for="reactor in reactors" :key="reactor.id"><a :href="reactor.account.uri" target="_blank" rel="noopener noreferrer">{{ reactor.account.name || reactor.account.username }} <span>@{{ reactor.account.username }}@{{ reactor.account.host }}</span></a></div>
		<MkButton v-if="moreReactors" small :disabled="busy" @click="showReactors(selectedReaction, true)">{{ i18n.ts.more }}</MkButton>
	</div>
	<p v-if="compact && error" role="alert">{{ i18n.ts._gridspace.actionFailed }} <MkA to="/settings/gridspace">{{ i18n.ts._gridspace.title }}</MkA></p>
	<MkButton v-if="!compact && !opened" small @click="openActions">{{ i18n.ts._gridspace.actionOpen }}</MkButton>
	<template v-else-if="!compact">
		<MkLoading v-if="busy && !info"/>
		<p v-if="error" role="alert">{{ i18n.ts._gridspace.actionFailed }}</p>
		<template v-if="info">
			<strong>{{ i18n.tsx._gridspace.actionIdentity({ account: `@${info.account.username}@${info.account.host}` }) }}</strong>
			<template v-if="info.canInteract">
				<div class="_buttons">
					<MkButton v-for="emoji in quickReactions" :key="emoji" small :disabled="busy" @click="addReaction(emoji)">{{ emoji }}</MkButton>
				</div>
				<form :class="$style.form" @submit.prevent="addReaction(reaction.trim())">
					<label>{{ i18n.ts._gridspace.actionReaction }}<input v-model="reaction" :disabled="busy" maxlength="128" :placeholder="i18n.ts._gridspace.actionReactionHint" autocomplete="off"></label>
					<MkButton type="submit" small :disabled="busy || !reaction.trim()">{{ i18n.ts._gridspace.actionReact }}</MkButton>
				</form>
				<div class="_buttons">
					<MkButton v-for="ownReaction in note.myReactions ?? (note.myReaction ? [note.myReaction] : [])" :key="ownReaction" small :disabled="busy" @click="act({ action: note.extendedReactions ? 'remove-reaction' : 'react', reaction: note.extendedReactions ? ownReaction : null })">{{ i18n.ts._gridspace.actionUnreact }} <MkReactionIcon :reaction="ownReaction" :emojiUrl="note.reactionEmojis?.[ownReaction.replace(/^:|:$/g, '')]"/></MkButton>
				</div>
			</template>
			<template v-else><p>{{ i18n.ts._gridspace.actionConsent }}</p><MkA to="/settings/gridspace">{{ i18n.ts._gridspace.actionAuthorize }}</MkA></template>
		</template>
		<div class="_buttons"><MkButton v-if="error" small :disabled="busy" @click="openActions">{{ i18n.ts.reload }}</MkButton><MkButton small :disabled="busy" @click="closeActions">{{ i18n.ts.close }}</MkButton></div>
	</template>
</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import MkPoll from '@/components/MkPoll.vue';
import MkReactionsViewer from '@/components/MkReactionsViewer.vue';
import type { ReactionTransport } from '@/utility/reaction-transport.js';
import * as os from '@/os.js';
import { prefer } from '@/preferences.js';
import { reactionPicker } from '@/utility/reaction-picker.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{ note: entities.GridspacePrivateNotesResponse['notes'][number]; compact?: boolean }>();
const emit = defineEmits<{ (event: 'changed', note: entities.GridspacePrivateNotesResponse['notes'][number]): void; (event: 'unavailable'): void }>();
const info = shallowRef<entities.GridspacePrivateActionResponse | null>(null);
const opened = ref(false);
const reactionRevision = ref(0);
watch(() => props.note, () => { reactionRevision.value++; });
const busy = ref(false);
const error = ref(false);
const reaction = ref('');
const selectedReaction = ref<string | null>(null);
const reactors = ref<NonNullable<entities.GridspacePrivateActionResponse['reactors']>>([]);
const moreReactors = ref(false);
const now = ref(Date.now());
const quickReactions = ['👍', '❤', '🎉', '😆', '🙏'];
let controller = new AbortController();
let generation = 0;
const timer = window.setInterval(() => { now.value = Date.now(); }, 10000);

function canVote(index: number) {
	const poll = props.note.poll;
	return !!poll && !(poll.expiresAt && Date.parse(poll.expiresAt) <= now.value) && !poll.choices[index].isVoted && (poll.multiple || !poll.choices.some(choice => choice.isVoted));
}

async function act(options: Omit<entities.GridspacePrivateActionRequest, 'noteId'>) {
	if (busy.value || (!['prepare', 'reaction-list'].includes(options.action ?? 'prepare') && !info.value?.canInteract)) return false;
	if (options.action === 'vote' && (options.choice === undefined || !canVote(options.choice))) return false;
	if (options.action === 'react' && options.reaction !== null && !options.reaction?.trim()) return false;
	const current = generation;
	busy.value = true; error.value = false;
	try {
		const result = await misskeyApi('gridspace/private-action', { ...options, noteId: props.note.id, channelId: props.note.channelId ?? undefined,
			expectedActorUri: options.expectedActorUri ?? (['prepare', 'reaction-list'].includes(options.action ?? 'prepare') ? undefined : info.value?.account.uri) }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
		if (current !== generation) return false;
		if (options.expectedActorUri && result.account.uri !== options.expectedActorUri) { error.value = true; return false; }
		info.value = result;
		if (options.action === 'reaction-list') {
			const rows = result.reactors ?? [];
			reactors.value = options.untilId ? [...reactors.value, ...rows] : rows;
			moreReactors.value = rows.length === 10;
		} else if (options.action !== 'prepare') {
			selectedReaction.value = null; reactors.value = []; moreReactors.value = false;
		}
		emit('changed', result.note);
		return true;
	} catch (err) {
		if (current !== generation) return false;
		error.value = true;
		const reason = (err as { info?: { reason?: string } }).info?.reason;
		if (reason === 'AUTHORIZATION_REVOKED' || reason === 'LINK_REVOKED') { closeActions(); emit('unavailable'); }
		return false;
	} finally { if (current === generation) busy.value = false; }
}

function openActions() { opened.value = true; void act({ action: 'prepare' }); }

function addReaction(value: string) { if (value.trim()) void act({ action: props.note.extendedReactions ? 'add-reaction' : 'react', reaction: value.trim() }); }

async function prepareInteraction(expectedActorUri = info.value?.account.uri) {
	if (!await act({ action: 'prepare', expectedActorUri }) || !info.value?.canInteract) { error.value = true; return false; }
	return true;
}

async function vote(choice: number) { return await prepareInteraction() && await act({ action: 'vote', choice }); }

async function toggleReaction(value: string, expectedActorUri = info.value?.account.uri) {
	if (!await prepareInteraction(expectedActorUri)) return;
	const current = generation;
	const actor = info.value?.account.uri;
	const own = props.note.myReactions?.includes(value) || props.note.myReaction === value;
	if (own || prefer.s.confirmOnReact) {
		const result = await os.confirm({ type: own ? 'warning' : 'question', text: own ? i18n.ts.cancelReactionConfirm : i18n.tsx.reactAreYouSure({ emoji: value }) });
		if (result.canceled) return;
	}
	if (current !== generation || actor !== info.value?.account.uri) return;
	await act({ action: props.note.extendedReactions ? own ? 'remove-reaction' : 'add-reaction' : 'react', reaction: own && !props.note.extendedReactions ? null : value });
}

async function react(event: MouseEvent) {
	const anchor = event.currentTarget as HTMLElement;
	if (!await prepareInteraction()) return;
	const current = generation; const actor = info.value?.account.uri;
	reactionPicker.show(anchor, null, value => { if (current === generation && actor === info.value?.account.uri) void toggleReaction(value, actor); }, () => anchor.focus());
}

const reactionTransport: ReactionTransport = {
	canToggle: () => !busy.value,
	toggle: toggleReaction,
	showUsers: showReactors,
	previews: reaction => (props.note.reactionPreviews ?? []).filter(row => row.reaction.replace('@.:', ':') === reaction.replace('@.:', ':')).map(row => row.account),
	users: async reaction => {
		const current = generation;
		const result = await misskeyApi('gridspace/private-action', { action: 'reaction-list', reaction, limit: 10, noteId: props.note.id, channelId: props.note.channelId ?? undefined }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
		if (current !== generation || window.document.hidden) return [];
		return (result.reactors ?? []).map(row => row.account);
	},
};

defineExpose({ react });

function showReactors(value: string, more = false) {
	if (busy.value) return;
	if (!more) { reactors.value = []; moreReactors.value = false; }
	selectedReaction.value = value; opened.value = true;
	void act({ action: 'reaction-list', reaction: value, limit: 10, untilId: more ? reactors.value.at(-1)?.id : undefined });
}

function closeActions() { generation++; controller.abort(); controller = new AbortController(); opened.value = false; info.value = null; busy.value = false; reaction.value = ''; selectedReaction.value = null; reactors.value = []; moreReactors.value = false; error.value = false; }

function visibility() { if (window.document.hidden) closeActions(); }

window.document.addEventListener('visibilitychange', visibility);
watch([() => props.note.id, () => props.note.channelId], closeActions);
onDeactivated(closeActions);
onBeforeUnmount(() => { closeActions(); window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); });
</script>

<style lang="scss" module>
.choices { padding-inline-start: 20px; li { margin-block: 8px; } }
.reaction { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; background: var(--MI_THEME-buttonBg); }
.selected { box-shadow: inset 0 0 0 1px var(--MI_THEME-accent); }
.form { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; label { display: grid; gap: 6px; } input { color: var(--MI_THEME-fg); background: var(--MI_THEME-panel); border: 1px solid var(--MI_THEME-divider); border-radius: 6px; padding: 8px; font: inherit; } }
</style>
