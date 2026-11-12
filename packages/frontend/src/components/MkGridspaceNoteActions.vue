<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps_s" data-gridspace-note-actions>
	<ul v-if="note.poll" :class="$style.choices">
		<li v-for="(choice, index) in note.poll.choices" :key="index">
			<Mfm :text="choice.text" :author="note.author" :emojiUrls="note.emojis ?? {}" :plain="true" :enableEmojiMenu="false"/>
			<span> — {{ choice.votes }} <i v-if="choice.isVoted" class="ti ti-check" :aria-label="i18n.ts._gridspace.actionVoted"></i></span>
			<MkButton v-if="info?.canInteract" small :disabled="busy || !canVote(index)" @click="act({ action: 'vote', choice: index })">{{ i18n.ts._poll.vote }}</MkButton>
		</li>
	</ul>
	<div v-if="Object.keys(note.reactions ?? {}).length" class="_buttons">
		<span v-for="(count, reactionKey) in note.reactions" :key="reactionKey" :class="$style.reaction">
			<MkReactionIcon :reaction="String(reactionKey)" :emojiUrl="note.reactionEmojis?.[String(reactionKey).replace(/^:|:$/g, '')]"/> {{ count }}
		</span>
	</div>
	<MkButton v-if="!opened" small @click="openActions">{{ i18n.ts._gridspace.actionOpen }}</MkButton>
	<template v-else>
		<MkLoading v-if="busy && !info"/>
		<p v-if="error" role="alert">{{ i18n.ts._gridspace.actionFailed }}</p>
		<template v-if="info">
			<strong>{{ i18n.tsx._gridspace.actionIdentity({ account: `@${info.account.username}@${info.account.host}` }) }}</strong>
			<template v-if="info.canInteract">
				<div class="_buttons">
					<MkButton v-for="emoji in quickReactions" :key="emoji" small :disabled="busy" @click="act({ action: 'react', reaction: emoji })">{{ emoji }}</MkButton>
				</div>
				<form :class="$style.form" @submit.prevent="act({ action: 'react', reaction: reaction.trim() })">
					<label>{{ i18n.ts._gridspace.actionReaction }}<input v-model="reaction" :disabled="busy" maxlength="128" :placeholder="i18n.ts._gridspace.actionReactionHint" autocomplete="off"></label>
					<MkButton type="submit" small :disabled="busy || !reaction.trim()">{{ i18n.ts._gridspace.actionReact }}</MkButton>
				</form>
				<MkButton v-if="note.myReaction" small :disabled="busy" @click="act({ action: 'react', reaction: null })">{{ i18n.ts._gridspace.actionUnreact }} <MkReactionIcon :reaction="note.myReaction" :emojiUrl="note.reactionEmojis?.[note.myReaction.replace(/^:|:$/g, '')]"/></MkButton>
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
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{ note: entities.GridspacePrivateNotesResponse['notes'][number] }>();
const emit = defineEmits<{ (event: 'changed', note: entities.GridspacePrivateNotesResponse['notes'][number]): void; (event: 'unavailable'): void }>();
const info = shallowRef<entities.GridspacePrivateActionResponse | null>(null);
const opened = ref(false);
const busy = ref(false);
const error = ref(false);
const reaction = ref('');
const now = ref(Date.now());
const quickReactions = ['👍', '❤', '🎉', '😆', '🙏'];
let controller = new AbortController();
let generation = 0;
const timer = window.setInterval(() => { now.value = Date.now(); }, 10000);

function canVote(index: number) {
	const poll = props.note.poll;
	return !!poll && !(poll.expiresAt && Date.parse(poll.expiresAt) <= now.value) && !poll.choices[index].isVoted && (poll.multiple || !poll.choices.some(choice => choice.isVoted));
}

async function act(options: { action: 'prepare' | 'react' | 'vote'; reaction?: string | null; choice?: number }) {
	if (busy.value || (options.action !== 'prepare' && !info.value?.canInteract)) return;
	if (options.action === 'vote' && (options.choice === undefined || !canVote(options.choice))) return;
	if (options.action === 'react' && options.reaction !== null && !options.reaction?.trim()) return;
	const current = generation;
	busy.value = true; error.value = false;
	try {
		const result = await misskeyApi('gridspace/private-action', { ...options, noteId: props.note.id }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
		if (current !== generation) return;
		info.value = result;
		emit('changed', result.note);
	} catch (err) {
		if (current !== generation) return;
		error.value = true;
		const reason = (err as { info?: { reason?: string } }).info?.reason;
		if (reason === 'AUTHORIZATION_REVOKED' || reason === 'LINK_REVOKED') { closeActions(); emit('unavailable'); }
	} finally { if (current === generation) busy.value = false; }
}

function openActions() { opened.value = true; void act({ action: 'prepare' }); }

function closeActions() { generation++; controller.abort(); controller = new AbortController(); opened.value = false; info.value = null; busy.value = false; reaction.value = ''; error.value = false; }

function visibility() { if (window.document.hidden) closeActions(); }

window.document.addEventListener('visibilitychange', visibility);
watch(() => props.note.id, closeActions);
onDeactivated(closeActions);
onBeforeUnmount(() => { closeActions(); window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); });
</script>

<style lang="scss" module>
.choices { padding-inline-start: 20px; li { margin-block: 8px; } }
.reaction { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; background: var(--MI_THEME-buttonBg); }
.form { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; label { display: grid; gap: 6px; } input { color: var(--MI_THEME-fg); background: var(--MI_THEME-panel); border: 1px solid var(--MI_THEME-divider); border-radius: 6px; padding: 8px; font: inherit; } }
</style>
