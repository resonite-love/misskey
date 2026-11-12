<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps_m">
	<MkInfo>{{ i18n.ts._gridspace.description }}</MkInfo>
	<MkLoading v-if="!status && !error"/>
	<MkInfo v-if="error" warn role="alert">{{ error }}</MkInfo>
	<MkButton v-if="!status && error" :disabled="busy" @click="refresh">{{ i18n.ts.reload }}</MkButton>
	<template v-if="status">
		<MkInfo v-if="!status.enabled">{{ i18n.ts._gridspace.disabled }}</MkInfo>
		<template v-else>
			<div class="_gaps_s">
				<div>{{ i18n.ts._gridspace.peer }}: {{ status.peerOrigin }}</div>
				<div v-if="status.peerUsername">{{ i18n.ts._gridspace.account }}: @{{ status.peerUsername }}</div>
				<div role="status">{{ stateLabel(status.state) }}</div>
			</div>
			<p>{{ i18n.ts._gridspace.permissions }}</p>
			<MkInfo>{{ i18n.ts._gridspace.scope }}</MkInfo>
			<div class="_buttons">
				<MkButton v-if="status.state === 'unlinked' || status.state === 'revoked'" primary :disabled="busy" @click="start">{{ i18n.ts._gridspace.start }}</MkButton>
				<MkButton v-else-if="status.initiator" :disabled="busy" @click="start">{{ i18n.ts._gridspace.reauthorize }}</MkButton>
				<MkButton v-if="status.state === 'active' || status.state === 'preparing'" danger :disabled="busy" @click="revoke">{{ i18n.ts._gridspace.revoke }}</MkButton>
				<MkButton v-if="status.failed && status.state === 'active'" :disabled="busy" @click="retry">{{ i18n.ts._gridspace.retry }}</MkButton>
				<MkButton :disabled="busy" @click="refresh">{{ i18n.ts.reload }}</MkButton>
			</div>
			<MkInfo v-if="status.lastError" warn>{{ errorLabel(status.lastError) }}</MkInfo>
			<section v-if="status.state === 'active'" class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.privateTitle }}</h2>
				<p>{{ i18n.ts._gridspace.privateConsent }}</p>
				<MkInfo v-if="readGrant?.granted">{{ i18n.ts._gridspace.privateGranted }}</MkInfo>
				<div class="_buttons">
					<MkButton :disabled="busy" @click="startPrivate">{{ i18n.ts._gridspace.privateAuthorize }}</MkButton>
					<MkButton v-if="readGrant?.granted" danger :disabled="busy" @click="revokePrivate">{{ i18n.ts._gridspace.privateRevoke }}</MkButton>
				</div>
				<MkA to="/gridspace/private">{{ i18n.ts._gridspace.privateHome }}</MkA>
			</section>
			<template v-if="status.total">
				<div aria-live="polite">{{ i18n.tsx._gridspace.progress({ total: status.total, done: status.done, pending: status.pending, requested: status.requested, failed: status.failed, skipped: status.skipped }) }}</div>
				<div v-for="item in status.items" :key="item.uri" :class="$style.item">
					<a :href="item.uri" target="_blank" rel="noopener noreferrer">{{ item.uri }}</a>
					<span>{{ stateLabel(item.state) }}</span>
				</div>
				<div v-if="status.total > status.items.length">{{ i18n.ts._gridspace.firstHundred }}</div>
			</template>
			<MkA v-if="status.state === 'active'" to="/">{{ i18n.ts._gridspace.openHome }}</MkA>
		</template>
	</template>
</div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';

const status = ref<entities.GridspaceLinkResponse | null>(null);
const readGrant = ref<entities.GridspacePrivateGrantResponse | null>(null);
const busy = ref(false);
const error = ref('');
const storageKey = `gridspace-link:${$i?.id}`;
const query = new URLSearchParams(window.location.search);
let poll: number | undefined;
let stopped = false;

function errorLabel(reason: string): string {
	if (reason === 'AUTHORIZATION_REVOKED' || reason === 'INVALID_CALLBACK') return i18n.ts._gridspace.authorizationError;
	if (reason === 'LINK_CONFLICT') return i18n.ts._gridspace.conflict;
	if (reason === 'LINK_REVOKED') return i18n.ts._gridspace.revoked;
	if (reason === 'REVOKE_PENDING') return i18n.ts._gridspace.revokePending;
	if (reason === 'SNAPSHOT_TOO_LARGE') return i18n.ts._gridspace.tooMany;
	return i18n.ts._gridspace.connectionError;
}

function stateLabel(state: string): string {
	const labels: Record<string, string> = {
		unlinked: i18n.ts._gridspace.unlinked, preparing: i18n.ts._gridspace.preparing,
		active: i18n.ts._gridspace.active, revoked: i18n.ts._gridspace.revoked,
		pending: i18n.ts._gridspace.pending, requested: i18n.ts._gridspace.requested,
		done: i18n.ts._gridspace.done, failed: i18n.ts._gridspace.failed,
		skipped: i18n.ts._gridspace.skipped, cancelled: i18n.ts._gridspace.cancelled,
	};
	return labels[state] ?? i18n.ts._gridspace.failed;
}

async function perform(action: () => Promise<void>) {
	if (busy.value) return;
	busy.value = true;
	error.value = '';
	try { await action(); } catch (err) {
		const reason = (err as { info?: { reason?: string } }).info?.reason;
		error.value = errorLabel(reason ?? 'PEER_UNAVAILABLE');
	} finally { busy.value = false; }
}

async function refresh() {
	await perform(async () => {
		status.value = await misskeyApi('gridspace/link', { action: 'status' });
		readGrant.value = await misskeyApi('gridspace/private-grant', { action: 'status' });
	});
}

async function start() {
	await perform(async () => {
		const result = await misskeyApi('gridspace/link', { action: 'start' });
		if (!result.authorizationUrl || !result.clientKey) throw new Error('Missing authorization URL');
		sessionStorage.setItem(storageKey, result.clientKey);
		sessionStorage.setItem(`${storageKey}:purpose`, 'link');
		window.location.assign(result.authorizationUrl);
	});
}

async function startPrivate() {
	await perform(async () => {
		const result = await misskeyApi('gridspace/private-grant', { action: 'start' });
		if (!result.authorizationUrl || !result.clientKey) throw new Error('Missing authorization URL');
		sessionStorage.setItem(storageKey, result.clientKey);
		sessionStorage.setItem(`${storageKey}:purpose`, 'private');
		window.location.assign(result.authorizationUrl);
	});
}

async function revokePrivate() {
	await perform(async () => {
		try { readGrant.value = await misskeyApi('gridspace/private-grant', { action: 'revoke' }); } finally { readGrant.value = await misskeyApi('gridspace/private-grant', { action: 'status' }); }
	});
}

async function revoke() {
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._gridspace.revokeConfirm });
	if (canceled) return;
	await perform(async () => {
		status.value = await misskeyApi('gridspace/link', { action: 'revoke' });
		sessionStorage.removeItem(storageKey);
	});
}

async function retry() {
	await perform(async () => { status.value = await misskeyApi('gridspace/link', { action: 'retry' }); });
}

onMounted(async () => {
	if (query.has('code') || query.has('error')) {
		// A router replacement remounts settings pages and loses the in-flight result.
		window.history.replaceState(window.history.state, '', '/settings/gridspace');
		const clientKey = sessionStorage.getItem(storageKey);
		if (query.has('code') && clientKey && query.get('state') && query.get('iss')) {
			await perform(async () => {
				const input = { action: 'finish' as const, state: query.get('state')!, code: query.get('code')!, issuer: query.get('iss')!, clientKey };
				if (sessionStorage.getItem(`${storageKey}:purpose`) === 'private') readGrant.value = await misskeyApi('gridspace/private-grant', input);
				else status.value = await misskeyApi('gridspace/link', input);
				sessionStorage.removeItem(storageKey);
				sessionStorage.removeItem(`${storageKey}:purpose`);
			});
		} else {
			error.value = i18n.ts._gridspace.authorizationError;
		}
	}
	if (!status.value) {
		try { status.value = await misskeyApi('gridspace/link', { action: 'status' }); } catch { error.value ||= i18n.ts._gridspace.connectionError; }
	}
	if (stopped) return;
	try { readGrant.value = await misskeyApi('gridspace/private-grant', { action: 'status' }); } catch { error.value ||= i18n.ts._gridspace.connectionError; }
	if (stopped) return;
	poll = window.setInterval(() => { if (status.value?.pending && !busy.value) void refresh(); }, 3000);
});
onUnmounted(() => { stopped = true; window.clearInterval(poll); });

definePage(() => ({ title: i18n.ts._gridspace.title, icon: 'ti ti-link' }));
</script>

<style lang="scss" module>
.item {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--MI-margin);
	overflow-wrap: anywhere;
	padding-block: 8px;
	border-bottom: 1px solid var(--MI_THEME-divider);
}
</style>
