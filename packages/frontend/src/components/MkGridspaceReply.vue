<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section class="_gaps_s" :class="$style.root" data-gridspace-reply>
	<MkLoading v-if="loading"/>
	<MkInfo v-if="error" warn role="alert">{{ error }}</MkInfo>
	<template v-if="info && !createdId">
		<strong>{{ i18n.tsx._gridspace.replyIdentity({ account: `@${info.account.username}@${info.account.host}` }) }}</strong>
		<p>{{ info.visibility === 'specified' ? i18n.ts._gridspace.replySpecified : i18n.ts._gridspace.replyFollowers }}</p>
		<div v-if="info.recipients.length">{{ i18n.ts._gridspace.replyRecipients }}: {{ info.recipients.map(person => `@${person.username}@${person.host}`).join(', ') }}</div>
		<div v-if="info.localOnly"><i class="ti ti-rocket-off" aria-hidden="true"></i> {{ i18n.ts._gridspace.replyLocalOnly }}</div>
		<template v-if="info.canReply">
			<template v-if="pending?.action !== 'status'">
				<label :class="$style.field"><span>{{ i18n.ts._gridspace.replyCw }}</span><input v-model="cw" :disabled="!!pending || sending" maxlength="100" autocomplete="off"></label>
				<label :class="$style.field"><span>{{ i18n.ts.text }}</span><textarea v-model="text" :disabled="!!pending || sending" rows="5" autocomplete="off"></textarea></label>
				<div>{{ Array.from(text).length }} / {{ info.maxTextLength }}</div>
			</template>
			<p v-else>{{ i18n.ts._gridspace.replyPending }}</p>
			<MkButton v-if="pending" primary :disabled="sending" @click="send">{{ pending.action === 'status' ? i18n.ts._gridspace.replyCheck : i18n.ts._gridspace.replyRetry }}</MkButton>
			<MkButton v-else primary :disabled="sending || !text.trim() || Array.from(text).length > info.maxTextLength" @click="send">{{ i18n.ts._gridspace.replySend }}</MkButton>
			<MkButton v-if="pending" :disabled="sending" @click="discard">{{ i18n.ts._gridspace.replyDiscard }}</MkButton>
		</template>
		<template v-else>
			<p>{{ i18n.ts._gridspace.replyConsent }}</p>
			<MkA to="/settings/gridspace">{{ i18n.ts._gridspace.replyAuthorize }}</MkA>
		</template>
	</template>
	<template v-if="createdId">
		<p role="status">{{ i18n.ts._gridspace.replySent }}</p>
		<MkA :to="`/gridspace/private?noteId=${createdId}`">{{ i18n.ts._gridspace.replyOpen }}</MkA>
	</template>
	<MkButton v-if="!info && !loading" @click="load">{{ i18n.ts.retry }}</MkButton>
	<MkButton :disabled="sending" @click="close">{{ i18n.ts.close }}</MkButton>
</section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { pendingReplyRequest, rememberReplyRequest, forgetReplyRequest } from '@/utility/gridspace-reply-request.js';
import * as os from '@/os.js';

const props = defineProps<{ noteId: string }>();
const accountId = $i?.id ?? 'storybook';
const emit = defineEmits<{ (event: 'close'): void }>();
const info = shallowRef<entities.GridspacePrivateReplyResponse | null>(null);
const loading = ref(false);
const sending = ref(false);
const error = ref('');
const text = ref('');
const cw = ref('');
const createdId = ref<string | null>(null);
const pending = shallowRef<entities.GridspacePrivateReplyRequest | null>(null);
let generation = 0;
let controller = new AbortController();
const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);

function clear() {
	generation++; controller.abort(); controller = new AbortController();
	info.value = null; pending.value = null; text.value = ''; cw.value = ''; createdId.value = null; loading.value = false; sending.value = false;
}

async function load() {
	clear(); error.value = ''; loading.value = true;
	const current = generation;
	try {
		const requestId = pendingReplyRequest(accountId, props.noteId);
		if (requestId) pending.value = { action: 'status', noteId: props.noteId, requestId };
		const result = await misskeyApi('gridspace/private-reply', { action: 'prepare', noteId: props.noteId }, undefined, signal());
		if (generation === current) info.value = result;
	} catch { if (generation === current) error.value = i18n.ts._gridspace.replyUnavailable; } finally { if (generation === current) loading.value = false; }
}

async function send() {
	if (sending.value || !info.value?.canReply || (!pending.value && (!text.value.trim() || Array.from(text.value).length > info.value.maxTextLength))) return;
	const current = generation; sending.value = true; error.value = '';
	try {
		if (!pending.value) {
			const fresh = crypto.randomUUID();
			const requestId = rememberReplyRequest(accountId, props.noteId, fresh);
			pending.value = requestId === fresh
				? { action: 'send', noteId: props.noteId, requestId, text: text.value, cw: cw.value || null }
				: { action: 'status', noteId: props.noteId, requestId };
		}
		const result = await misskeyApi('gridspace/private-reply', pending.value, undefined, signal());
		if (generation !== current) return;
		if (!result.createdNoteId) { error.value = i18n.ts._gridspace.replyPending; return; }
		forgetReplyRequest(accountId, props.noteId, pending.value.requestId!);
		createdId.value = result.createdNoteId; pending.value = null; text.value = ''; cw.value = '';
	} catch (err) {
		if (generation !== current) return;
		const reason = (err as { info?: { reason?: string } }).info?.reason;
		if (reason === 'REPLY_REJECTED' || reason === 'RATE_LIMITED') {
			if (pending.value?.requestId) forgetReplyRequest(accountId, props.noteId, pending.value.requestId);
			pending.value = null; error.value = i18n.ts._gridspace.replyRejected;
		} else { error.value = i18n.ts._gridspace.replyUncertain; }
	} finally { if (generation === current) sending.value = false; }
}

async function close() {
	if (sending.value) return;
	clear(); emit('close');
}

async function discard() {
	if (sending.value || !pending.value?.requestId) return;
	const request = pending.value;
	if ((await os.confirm({ type: 'warning', text: i18n.ts._gridspace.replyCloseUncertain })).canceled) return;
	forgetReplyRequest(accountId, request.noteId, request.requestId!);
	await load();
}

function visibility() { if (window.document.hidden) { clear(); emit('close'); } }

window.document.addEventListener('visibilitychange', visibility);
watch(() => props.noteId, load, { immediate: true });
onDeactivated(clear);
onBeforeUnmount(() => { clear(); window.document.removeEventListener('visibilitychange', visibility); });
</script>

<style lang="scss" module>
.root { padding-block: 16px; overflow-wrap: anywhere; }
.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	input, textarea { box-sizing: border-box; width: 100%; padding: 10px; color: var(--MI_THEME-fg); background: var(--MI_THEME-panel); border: 1px solid var(--MI_THEME-divider); border-radius: 6px; font: inherit; }
	textarea { resize: vertical; }
}
</style>
