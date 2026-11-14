<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section :class="$style.root" data-gridspace-post-form @dragover.prevent @drop.prevent="dropFiles">
	<MkPostFormHeader :fixed="embedded" @cancel="close">
		<template #account>
			<img v-if="info" :class="$style.avatar" :src="info.account.avatarUrl" alt="" style="border-radius: 100%;">
			<span v-if="info" :class="$style.peerIdentity" :title="identity">{{ identity }}</span>
		</template>
		<span :class="[$style.headerRightItem, $style.visibility]" :title="audience"><i :class="channelId ? 'ti ti-device-tv' : info?.visibility === 'specified' ? 'ti ti-mail' : 'ti ti-lock'"></i><span :class="$style.headerRightButtonText">{{ audience }}</span></span>
		<span v-if="info?.localOnly && !channelId" :title="i18n.ts._visibility.disableFederation"><i class="ti ti-rocket-off"></i></span>
		<button class="_button" :class="$style.submit" :disabled="!canSend" data-testid="post-form-submit" @click="send"><div :class="$style.submitInner"><MkEllipsis v-if="sending"/><template v-else>{{ pending ? i18n.ts.retry : reply ? i18n.ts.reply : renote ? i18n.ts.quote : i18n.ts.note }}</template><i style="margin-left: 6px;" :class="reply ? 'ti ti-arrow-back-up' : renote ? 'ti ti-quote' : 'ti ti-send'"></i></div></button>
	</MkPostFormHeader>
	<MkLoading v-if="loading"/>
	<MkInfo v-if="error" warn role="alert" :class="$style.peerInfo">{{ error }}</MkInfo>
	<template v-if="info">
		<div v-if="!channelId && info.recipients.length" :class="$style.peerInfo">{{ i18n.ts._gridspace.replyRecipients }}: {{ info.recipients.map(person => `@${person.username}@${person.host}`).join(', ') }}</div>
		<div v-if="targetNote" :class="$style.targetNote"><i v-if="renote" class="ti ti-quote"></i><strong>{{ targetNote.author.name || targetNote.author.username }}</strong><Mfm :text="targetNote.cw ?? targetNote.text ?? ''" :author="targetNote.author" :emojiUrls="targetNote.emojis ?? {}" :plain="true"/></div>
		<template v-if="info.canReply">
			<fieldset :disabled="locked" :class="$style.peerFields">
				<MkPostFormFields :useCw="useCw" :channelColor="channel?.color"><template #cw><input ref="cwInput" v-model="cw" :class="$style.cw" :placeholder="i18n.ts.annotation" :aria-label="i18n.ts.annotation" maxlength="100" @keydown="keydown"></template><textarea ref="textarea" v-model="text" :class="$style.text" :aria-label="i18n.ts.text" :placeholder="reply ? i18n.ts._postForm.replyPlaceholder : renote ? i18n.ts._postForm.quotePlaceholder : i18n.ts._postForm.channelPlaceholder" data-testid="post-form-text" @keydown="keydown" @paste="pasteFiles"></textarea><template #counter><div v-if="remaining < 100" :class="[$style.textCount, { [$style.textOver]: remaining < 0 }]">{{ remaining }}</div></template></MkPostFormFields>
				<div v-if="uploader.items.value.length" :class="$style.peerAttachments"><MkUploaderItems :items="uploader.items.value" @showMenu="showFileMenu" @showMenuViaContextmenu="showFileMenu"/></div>
				<MkPollEditor v-if="poll" v-model="poll"/>
				<div v-if="preview" :class="$style.preview"><Mfm v-if="useCw" :text="cw" :author="info.account"/><Mfm :text="text" :author="info.account"/></div>
				<footer :class="$style.footer"><MkPostFormActionBar :poll="!!poll" :useCw="useCw" :canAttach="info.canAttach" showPreview :preview="preview" @upload="fileInput?.click()" @poll="togglePoll" @cw="useCw = !useCw" @mention="insertText('@')" @mfm="insertMfm" @preview="preview = !preview" @emoji="insertEmoji"/></footer>
				<input ref="fileInput" type="file" multiple hidden @change="selectFiles">
			</fieldset>
			<div v-if="pending" :class="$style.peerInfo"><p>{{ i18n.ts._gridspace.replyPending }}</p><MkButton :disabled="sending" @click="discard">{{ i18n.ts._gridspace.replyDiscard }}</MkButton></div>
		</template>
		<div v-else :class="$style.peerInfo"><p>{{ channelId ? i18n.ts._gridspace.channelPostUnavailable : i18n.ts._gridspace.replyConsent }}</p><MkA to="/settings/gridspace">{{ i18n.ts._gridspace.replyAuthorize }}</MkA></div>
	</template>
	<MkButton v-if="!info && !loading" :class="$style.peerInfo" @click="reauthorize">{{ i18n.ts.retry }}</MkButton>
</section>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { apiUrl, host } from '@@/js/config.js';
import type { entities } from 'misskey-js';
import type { PollEditorModelValue } from '@/components/MkPollEditor.vue';
import type { UploaderItem } from '@/composables/use-uploader.js';
import MkPostFormActionBar from '@/components/MkPostFormActionBar.vue';
import MkPostFormFields from '@/components/MkPostFormFields.vue';
import MkPostFormHeader from '@/components/MkPostFormHeader.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkUploaderItems from '@/components/MkUploaderItems.vue';
import MkPollEditor from '@/components/MkPollEditor.vue';
import { getUploadName, useUploader } from '@/composables/use-uploader.js';
import { Autocomplete } from '@/utility/autocomplete.js';
import { emojiPicker } from '@/utility/emoji-picker.js';
import { mfmFunctionPicker } from '@/utility/mfm-function-picker.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { pendingReplyRequest, rememberReplyRequest, forgetReplyRequest } from '@/utility/gridspace-reply-request.js';
import * as os from '@/os.js';

const props = defineProps<{ channelId?: string; channel?: { name: string; color: string }; reply?: entities.GridspacePrivateNotesResponse['notes'][number]; renote?: entities.GridspacePrivateNotesResponse['notes'][number]; embedded?: boolean; autofocus?: boolean }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'sent'): void }>();
const accountId = $i?.id ?? 'storybook';
const info = shallowRef<entities.GridspacePrivateReplyResponse | null>(null);
const loading = ref(false);
const sending = ref(false);
const error = ref('');
const text = ref('');
const cw = ref('');
const useCw = ref(false);
const preview = ref(false);
const poll = ref<PollEditorModelValue | null>(null);
const uploader = useUploader();
const uploaded = new Map<string, { blob: Blob; metadata: string; id: string }>();
const textarea = useTemplateRef('textarea');
const cwInput = useTemplateRef('cwInput');
const fileInput = useTemplateRef('fileInput');
type PostRequest = Omit<entities.GridspacePrivateReplyRequest, 'noteId'> & { noteId?: string; channelId?: string };
const pending = shallowRef<PostRequest | null>(null);
const locked = computed(() => sending.value || !!pending.value);
const identity = computed(() => info.value ? `@${info.value.account.username}@${info.value.account.host}` : '');
const audience = computed(() => props.channelId ? props.channel?.name ?? i18n.ts.channel : info.value?.visibility === 'specified' ? i18n.ts._visibility.specified : i18n.ts._visibility.followers);
const remaining = computed(() => (info.value?.maxTextLength ?? 0) - Array.from(text.value).length);
const targetNote = computed(() => props.reply ?? props.renote);
const validPoll = computed(() => !poll.value || (poll.value.choices.length >= 2 && poll.value.choices.length <= 10 && new Set(poll.value.choices).size === poll.value.choices.length && poll.value.choices.every(choice => choice.trim() && Array.from(choice).length <= 50)));
const canSend = computed(() => !!info.value?.canReply && !sending.value && !loading.value && (!!pending.value || (remaining.value >= 0 && validPoll.value && !!(text.value.trim() || uploader.items.value.length || poll.value) && !uploader.items.value.some(item => item.preprocessing))));
const target = () => ({ noteId: props.reply?.id, renoteId: props.renote?.id, channelId: props.channelId });
const operationKey = () => props.channelId ? `channel:${props.channelId}:${props.renote ? `quote:${props.renote.id}` : props.reply?.id ?? 'new'}` : props.reply!.id;
let generation = 0;
let active = true;
let rechecking = false;
let authorizedActor: string | undefined;
let controller = new AbortController();
const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);

function request(input: PostRequest) {
	if (props.channelId) return misskeyApi('gridspace/channel-post', { ...input, channelId: props.channelId }, undefined, signal());
	if (!props.reply) throw new Error('Missing reply target');
	return misskeyApi('gridspace/private-reply', { ...input, noteId: props.reply.id }, undefined, signal());
}

function clear() {
	generation++; controller.abort(); controller = new AbortController();
	info.value = null; pending.value = null; text.value = ''; cw.value = ''; poll.value = null; useCw.value = false; preview.value = false;
	uploader.reset(); uploaded.clear(); loading.value = false; sending.value = false;
	authorizedActor = undefined;
}

async function load() {
	clear(); error.value = ''; loading.value = true;
	const current = generation;
	try {
		const requestId = pendingReplyRequest(accountId, operationKey());
		if (requestId) pending.value = { action: 'status', ...target(), requestId };
		const result = await request({ action: 'prepare', ...target() });
		if (generation === current) {
			info.value = result;
			authorizedActor = result.account.uri;
			if (props.reply?.cw) { cw.value = props.reply.cw; useCw.value = true; }
			await nextTick(); if (props.autofocus) textarea.value?.focus();
		}
	} catch { if (generation === current) error.value = i18n.ts._gridspace.replyUnavailable; } finally { if (generation === current) loading.value = false; }
}

async function reauthorize() {
	if (!active || window.document.hidden || rechecking || sending.value || loading.value) return;
	rechecking = true;
	const current = generation;
	try {
		const result = await request({ action: 'prepare', ...target(), expectedActorUri: authorizedActor });
		if (current !== generation) return;
		info.value = result; authorizedActor ??= result.account.uri; error.value = '';
	} catch {
		if (current === generation) { info.value = null; error.value = i18n.ts._gridspace.replyUnavailable; }
	} finally { rechecking = false; }
}

function visibility() {
	if (window.document.hidden && !props.channelId) { clear(); emit('close'); return; }
	if (window.document.hidden) { generation++; controller.abort(); controller = new AbortController(); info.value = null; sending.value = false; loading.value = false; } else void reauthorize();
}

async function send() {
	if (!canSend.value || !info.value) return;
	const current = generation; sending.value = true; error.value = '';
	try {
		if (!pending.value) {
			const fileIds: string[] = [];
			for (const item of uploader.items.value) {
				const blob = item.preprocessedFile ?? item.file;
				const metadata = JSON.stringify([getUploadName(item), item.caption ?? '', item.isSensitive ?? false]);
				let cached = uploaded.get(item.id);
				if (!cached || cached.blob !== blob || cached.metadata !== metadata) {
					const form = new FormData();
					form.set('i', $i!.token); form.set('name', getUploadName(item));
					if (props.channelId) form.set('channelId', props.channelId);
					if (targetNote.value) form.set('noteId', targetNote.value.id);
					form.set('expectedActorUri', info.value.account.uri);
					form.set('comment', item.caption ?? ''); form.set('isSensitive', String(item.isSensitive ?? false)); form.set('file', blob, getUploadName(item));
					const response = await window.fetch(`${apiUrl}/gridspace/private-upload`, { method: 'POST', body: form, credentials: 'omit', cache: 'no-store', signal: signal() });
					if (!response.ok) throw new Error('upload');
					const result = await response.json() as entities.GridspacePrivateUploadResponse;
					if (generation !== current) return;
					cached = { blob, metadata, id: result.id }; uploaded.set(item.id, cached);
				}
				fileIds.push(cached.id);
			}
			const fresh = crypto.randomUUID();
			const requestId = rememberReplyRequest(accountId, operationKey(), fresh);
			pending.value = requestId === fresh
				? { action: 'send', ...target(), expectedActorUri: info.value.account.uri, requestId, text: text.value, cw: useCw.value ? cw.value : null, fileIds,
								poll: poll.value ? { choices: [...poll.value.choices], multiple: poll.value.multiple, expiresAt: poll.value.expiredAfter ? Date.now() + poll.value.expiredAfter : poll.value.expiresAt } : undefined }
				: { action: 'status', ...target(), requestId };
		}
		const result = await request(pending.value);
		if (generation !== current) return;
		if (!result.createdNoteId) { error.value = i18n.ts._gridspace.replyPending; return; }
		forgetReplyRequest(accountId, operationKey(), pending.value.requestId!);
		pending.value = null; text.value = ''; cw.value = ''; poll.value = null; useCw.value = false;
		uploader.reset(); uploaded.clear(); emit('sent');
	} catch (err) {
		if (generation !== current) return;
		if (!pending.value) { error.value = i18n.ts._gridspace.replyUploadFailed; return; }
		const reason = (err as { info?: { reason?: string } }).info?.reason;
		if (reason === 'REPLY_REJECTED' || reason === 'RATE_LIMITED') {
			if (pending.value.requestId) forgetReplyRequest(accountId, operationKey(), pending.value.requestId);
			pending.value = null; error.value = i18n.ts._gridspace.replyRejected;
		} else { error.value = i18n.ts._gridspace.replyUncertain; }
	} finally { if (generation === current) sending.value = false; }
}

function addFiles(files: File[]) {
	if (locked.value || !info.value?.canAttach) return;
	if (uploader.items.value.length + files.length > 16 || files.some(file => !file.size || file.size > 16 * 1024 * 1024)) { error.value = i18n.ts._gridspace.replyAttachmentHint; return; }
	uploader.addFiles(files);
}

function selectFiles(event: Event) { const input = event.target as HTMLInputElement; addFiles(Array.from(input.files ?? [])); input.value = ''; }

function dropFiles(event: DragEvent) { addFiles(Array.from(event.dataTransfer?.files ?? [])); }

function pasteFiles(event: ClipboardEvent) { if (event.clipboardData?.files.length) { event.preventDefault(); addFiles(Array.from(event.clipboardData.files)); } }

function showFileMenu(item: UploaderItem, event: MouseEvent) { if (!locked.value) os.popupMenu(uploader.getMenu(item), event.currentTarget ?? event.target); }

function togglePoll() { poll.value = poll.value ? null : { choices: ['', ''], multiple: false, expiresAt: null, expiredAfter: null }; }

function keydown(event: KeyboardEvent) { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void send(); } }

function insertText(value: string) {
	if (locked.value) return;
	const start = textarea.value?.selectionStart ?? text.value.length;
	const end = textarea.value?.selectionEnd ?? start;
	text.value = text.value.slice(0, start) + value + text.value.slice(end);
	void nextTick(() => { textarea.value?.focus(); textarea.value?.setSelectionRange(start + value.length, start + value.length); });
}

function insertEmoji(event: MouseEvent) { emojiPicker.show(event.currentTarget as HTMLElement, insertText, () => textarea.value?.focus()); }

function insertMfm(event: MouseEvent) { mfmFunctionPicker(event.currentTarget ?? event.target, tag => insertText(`$[${tag} ]`)); }

async function canClose() {
	if (sending.value) return false;
	if (text.value || cw.value || uploader.items.value.length || poll.value) return !(await os.confirm({ type: 'warning', text: i18n.ts._gridspace.discardPost })).canceled;
	return true;
}

async function close() { if (await canClose()) { clear(); emit('close'); } }

async function discard() {
	if (sending.value || !pending.value?.requestId) return;
	if ((await os.confirm({ type: 'warning', text: i18n.ts._gridspace.replyCloseUncertain })).canceled) return;
	forgetReplyRequest(accountId, operationKey(), pending.value.requestId); await load();
}

watch(textarea, (element, _, onCleanup) => { if (!element) return; const autocomplete = new Autocomplete(element, text, undefined, { localUserHost: host }); onCleanup(() => autocomplete.detach()); });
watch(cwInput, (element, _, onCleanup) => { if (!element) return; const autocomplete = new Autocomplete(element, cw, undefined, { localUserHost: host }); onCleanup(() => autocomplete.detach()); });
watch(() => [props.reply?.id, props.renote?.id, props.channelId], load, { immediate: true });
const timer = window.setInterval(reauthorize, 15000);
window.document.addEventListener('visibilitychange', visibility);
onDeactivated(() => { active = false; clear(); });
onActivated(() => { active = true; void reauthorize(); });
onBeforeUnmount(() => { active = false; window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); clear(); });
defineExpose({ canClose });
</script>

<style lang="scss" module>
@use './post-form.scss';
.peerIdentity { min-width: 0; font-size: 0.75em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.headerLeft { min-width: 0; }
.avatar { flex-shrink: 0; margin: 0; }
.peerInfo { margin: 12px 20px; overflow-wrap: anywhere; }
.peerFields { margin: 0; padding: 0; border: 0; min-width: 0; }
.peerAttachments { padding: 12px; }
</style>
