<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps_m" :class="$style.root">
	<MkButton v-if="store.s.accountSetupWizard !== -1" @click="resumeSetup">{{ i18n.ts._gridspace.signupResume }}</MkButton>
	<p>{{ i18n.ts._gridspace.introduction }}</p>
	<MkLoading v-if="!status && !error"/>
	<MkInfo v-if="error" warn role="alert">{{ error }}</MkInfo>
	<MkButton v-if="!status && error" :disabled="busy" @click="refresh">{{ i18n.ts.reload }}</MkButton>
	<template v-if="status">
		<MkInfo v-if="!status.enabled">{{ i18n.ts._gridspace.disabled }}</MkInfo>
		<template v-else>
			<div class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.linkStatus }}</h2>
				<div>{{ i18n.ts._gridspace.peer }}: {{ status.peerOrigin }}</div>
				<div v-if="status.peerUsername">{{ i18n.ts._gridspace.account }}: @{{ status.peerUsername }}</div>
				<div role="status">{{ stateLabel(status.state) }}</div>
			</div>
			<p>{{ i18n.ts._gridspace.permissions }}</p>
			<div class="_buttons">
				<MkButton v-if="status.state === 'unlinked' || status.state === 'revoked'" primary :disabled="busy" @click="start">{{ i18n.ts._gridspace.start }}</MkButton>
				<MkButton v-else-if="status.initiator" :disabled="busy" @click="start">{{ i18n.ts._gridspace.reauthorize }}</MkButton>
				<MkButton v-if="!status.driveShared && (status.state === 'active' || status.state === 'preparing')" danger :disabled="busy" @click="revoke">{{ i18n.ts._gridspace.revoke }}</MkButton>
				<MkButton :disabled="busy" @click="refresh">{{ i18n.ts.reload }}</MkButton>
			</div>
			<section v-if="status.state === 'active' && status.driveShared" class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.sharedDriveTitle }}</h2>
				<p>{{ i18n.ts._gridspace.sharedDriveDescription }}</p>
				<MkInfo>{{ i18n.ts._gridspace.sharedDriveLocked }}</MkInfo>
				<MkInfo v-if="!status.driveSeeded">{{ i18n.ts._gridspace.sharedDrivePreparing }}</MkInfo>
				<MkA to="/my/drive">{{ i18n.ts.drive }}</MkA>
			</section>
			<MkInfo v-if="status.lastError" warn>{{ errorLabel(status.lastError) }}</MkInfo>
			<section v-if="status.state === 'active'" class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.linkPermissions }}</h2>
				<MkInfo v-if="readGrant && !readGrant.available" warn>{{ i18n.ts._gridspace.connectionError }}</MkInfo>
				<MkInfo v-else-if="readGrant?.granted && readGrant.canReply && readGrant.canInteract && readGrant.canReadNotifications && readGrant.canWriteChannels && readGrant.canManageFollowRequests && (!status.channelsEnabled || (collectionsGrant?.favorites && collectionsGrant.clipFavorites && (status.driveShared || driveGrant?.granted)))">{{ i18n.ts._gridspace.allGranted }}</MkInfo>
				<MkInfo v-else>{{ i18n.ts._gridspace.upgradePermissions }}</MkInfo>
				<MkButton v-if="!status.initiator" :disabled="busy" @click="startPrivate">{{ i18n.ts._gridspace.authorizeAll }}</MkButton>
			</section>
			<template v-if="status.state === 'active' && status.initiator && status.channelsEnabled">
				<section class="_gaps_s">
					<h2>{{ i18n.ts._gridspace.profileTitle }}</h2>
					<p>{{ i18n.ts._gridspace.profileCopyDescription }}</p>
					<MkInfo v-if="profileResult?.complete" role="status">{{ i18n.tsx._gridspace.profileCopied({ copied: profileResult.copied.length, skipped: profileResult.skipped.length }) }}</MkInfo>
					<MkInfo v-if="profileError" warn role="alert">{{ i18n.ts._gridspace.profileCopyFailed }}</MkInfo>
					<MkButton :disabled="busy || profileResult?.complete" @click="retryProfile">{{ profileError ? i18n.ts.retry : i18n.ts._gridspace.profileCopy }}</MkButton>
				</section>
			</template>
			<div v-if="status.state === 'active' && (paletteCopied || paletteError)" class="_gaps_s">
				<MkInfo v-if="paletteCopied">{{ i18n.ts._gridspace.paletteCopied }}</MkInfo>
				<MkInfo v-if="paletteError" warn>{{ i18n.ts._gridspace.paletteCopyFailed }}</MkInfo>
				<MkButton v-if="paletteError" :disabled="busy" @click="retryPalette">{{ i18n.ts.retry }}</MkButton>
			</div>
			<section v-if="status.state === 'active' && status.initiator" class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.recentEmojiTitle }}</h2>
				<p>{{ i18n.ts._gridspace.recentEmojiDescription }}</p>
				<MkInfo v-if="recentEmojiCopied" role="status">{{ i18n.ts._gridspace.recentEmojiCopied }}</MkInfo>
				<MkInfo v-if="recentEmojiUnavailable" warn role="alert">{{ i18n.ts._gridspace.recentEmojiUnavailable }}</MkInfo>
				<MkButton :disabled="busy" @click="startRecentEmojis">{{ i18n.ts._gridspace.recentEmojiCopy }}</MkButton>
			</section>
			<template v-if="status.state === 'active' && status.initiator && status.channelsEnabled">
				<section class="_gaps_s">
					<h2>{{ i18n.ts._gridspace.listsTitle }}</h2>
					<p>{{ i18n.ts._gridspace.listsDescription }}</p>
					<MkGridspaceListImport :autoStart="listsAutoStart"/>
				</section>
				<section class="_gaps_s">
					<h2>{{ i18n.ts._gridspace.settingsTitle }}</h2>
					<p>{{ i18n.ts._gridspace.settingsCopyDescription }}</p>
					<p>{{ i18n.ts._gridspace.settingsCopyExclusions }}</p>
					<p>{{ i18n.ts._gridspace.settingsCopyDevice }}</p>
					<MkInfo v-if="settingsResult" role="status">{{ i18n.tsx._gridspace.settingsProgress({ done: settingsResult.done, total: settingsResult.total, failed: settingsResult.failed }) }}</MkInfo>
					<MkInfo v-if="settingsComplete" role="status">{{ i18n.ts._gridspace.settingsCopied }}</MkInfo>
					<MkInfo v-if="settingsError" warn role="alert">{{ i18n.ts._gridspace.settingsCopyFailed }}</MkInfo>
					<MkInfo v-if="layoutIssues.length" warn>{{ i18n.ts._gridspace.layoutPartial }} {{ layoutIssues.join('、') }}</MkInfo>
					<MkInfo v-if="skippedSettings.length" warn role="status">{{ i18n.tsx._gridspace.settingsSkipped({ count: skippedSettings.length }) }}</MkInfo>
					<MkButton :disabled="busy" @click="startSettings">{{ i18n.ts._gridspace.settingsCopy }}</MkButton>
					<MkButton v-if="settingsError && prefer.s.gridspaceSettingsImportRequest" :disabled="busy" @click="retrySettings">{{ i18n.ts.retry }}</MkButton>
				</section>
				<section class="_gaps_s">
					<h2>{{ i18n.ts._gridspace.playImportTitle }}</h2>
					<p>{{ i18n.ts._gridspace.playImportDescription }}</p>
					<div v-if="playImportResult?.started" role="status">{{ i18n.tsx._gridspace.playImportProgress({ done: playImportResult.done, total: playImportResult.total, failed: playImportResult.failed }) }}</div>
					<MkInfo v-if="playImportError" warn role="alert">{{ i18n.ts._gridspace.playImportFailed }}</MkInfo>
					<div class="_buttons">
						<MkButton :disabled="busy || playImportBusy || playImportResult?.complete" @click="runPlayImport(true, playImportError)">{{ playImportError ? i18n.ts.retry : i18n.ts._gridspace.playImportStart }}</MkButton>
						<MkButton v-if="playImportError" :disabled="busy || playImportBusy" @click="start">{{ i18n.ts._gridspace.reauthorize }}</MkButton>
						<MkA to="/play?tab=my">{{ i18n.ts._gridspace.openMyPlay }}</MkA>
					</div>
				</section>
				<section class="_gaps_s">
					<h2>{{ i18n.ts._gridspace.collectionsTitle }}</h2>
					<p>{{ i18n.ts._gridspace.collectionsDescription }}</p>
					<div class="_buttons">
						<MkA to="/my/favorites">{{ i18n.ts.favorites }}</MkA>
						<MkA to="/my/clips">{{ i18n.ts.clip }}</MkA>
					</div>
				</section>
				<section v-if="!status.driveShared" class="_gaps_s">
					<h2>{{ i18n.ts._gridspace.driveTitle }}</h2>
					<p>{{ i18n.ts._gridspace.driveDescription }}</p>
					<MkInfo v-if="driveGrant && !driveGrant.granted" warn>{{ i18n.ts._gridspace.driveNeedsGrant }}</MkInfo>
					<MkA to="/my/drive">{{ i18n.ts.drive }}</MkA>
				</section>
			</template>
			<section class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.followsTitle }}</h2>
				<p>{{ status.channelsEnabled ? i18n.ts._gridspace.description : i18n.ts._gridspace.sourceFollowDescription }}</p>
				<p>{{ i18n.ts._gridspace.followCopyConditions }}</p>
				<MkButton v-if="status.failed && status.state === 'active'" :disabled="busy" @click="retry">{{ i18n.ts._gridspace.retry }}</MkButton>
				<template v-if="status.total">
					<div aria-live="polite">{{ i18n.tsx._gridspace.progress({ total: status.total, done: status.done, pending: status.pending, requested: status.requested, failed: status.failed, skipped: status.skipped }) }}</div>
					<div v-for="item in status.items" :key="item.uri" :class="$style.item">
						<a :href="item.uri" target="_blank" rel="noopener noreferrer">{{ item.uri }}</a>
						<span>{{ stateLabel(item.state) }}</span>
					</div>
					<div v-if="status.total > status.items.length">{{ i18n.ts._gridspace.firstHundred }}</div>
				</template>
			</section>
			<section class="_gaps_s">
				<h2>{{ i18n.ts._gridspace.notesTitle }}</h2>
				<p>{{ i18n.ts._gridspace.scope }}</p>
			</section>
			<MkA v-if="status.state === 'active'" to="/">{{ i18n.ts._gridspace.openHome }}</MkA>
		</template>
	</template>
</div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';
import type { entities } from 'misskey-js';
import MkGridspaceListImport from '@/components/MkGridspaceListImport.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { store } from '@/store.js';
import { prefer } from '@/preferences.js';
import { gridspacePaletteSource, mergeGridspacePalette, mergeGridspaceRecentEmojis } from '@/utility/gridspace-palette.js';
import { parseClientSettings, portableSettingKeys } from '@/utility/gridspace-settings.js';
import { PREF_DEF } from '@/preferences/def.js';
import { mapLayoutSettings, layoutSettingKeys } from '@/utility/gridspace-layout.js';
import { $i } from '@/i.js';
import { updateCurrentAccount } from '@/accounts.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';

async function resumeSetup() {
	const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkUserSetupDialog.vue').then(module => module.default), {}, { closed: () => dispose() });
}

const status = ref<entities.GridspaceLinkResponse | null>(null);
const readGrant = ref<entities.GridspacePrivateGrantResponse | null>(null);
const busy = ref(false);
const error = ref('');
const paletteCopied = ref(false);
const paletteError = ref(false);
const recentEmojiCopied = ref(false);
const recentEmojiUnavailable = ref(false);
const profileResult = ref<entities.GridspaceProfileImportResponse | null>(null);
const profileError = ref(false);
const listsAutoStart = ref(false);
const collectionsGrant = ref<entities.GridspaceCollectionsResponse | null>(null);
const driveGrant = ref<entities.GridspaceDriveResponse | null>(null);
const settingsResult = ref<entities.GridspaceSettingsImportResponse | null>(null);
const settingsError = ref(false);
const settingsComplete = ref(false);
const layoutIssues = ref<string[]>([]);
const skippedSettings = ref<string[]>([]);
const playImportResult = ref<entities.GridspacePlayImportResponse | null>(null);
const playImportBusy = ref(false);
const playImportError = ref(false);
let playImportAutoStart = false;
let skipPlayImport = false;
let settingsRunning = false;
let settingsAttempted = false;
const storageKey = `gridspace-link:${$i?.id}`;
const query = new URLSearchParams(window.location.search);
let poll: number | undefined;
let stopped = false;
let paletteAttempted = false;
let profileAttempted = false;

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
		if (status.value?.channelsEnabled && status.value.state === 'active') collectionsGrant.value = await misskeyApi('gridspace/collections', { kind: 'status' });
		if (status.value?.channelsEnabled && status.value.state === 'active') driveGrant.value = await misskeyApi('gridspace/drive', { mode: 'status' });
		if (!paletteAttempted) await resumePalette();
		if (!profileAttempted) await resumeProfile();
	});
}

async function start() {
	await startLink(false);
}

async function startLink(recentEmojisOnly: boolean) {
	await perform(async () => {
		const result = await misskeyApi('gridspace/link', { action: 'start' });
		if (!result.authorizationUrl || !result.clientKey) throw new Error('Missing authorization URL');
		sessionStorage.setItem(storageKey, result.clientKey);
		sessionStorage.setItem(`${storageKey}:purpose`, 'link');
		if (recentEmojisOnly) sessionStorage.setItem(`${storageKey}:recent-emojis`, 'true');
		else sessionStorage.removeItem(`${storageKey}:recent-emojis`);
		await prefer.cloudReady;
		if (!recentEmojisOnly && (!status.value || ['unlinked', 'revoked'].includes(status.value.state))) prefer.commit('gridspaceSettingsImportRequest', crypto.randomUUID());
		prefer.commit('gridspacePaletteImportPending', true);
		if (!recentEmojisOnly) prefer.commit('gridspaceProfileImportPending', true);
		window.location.assign(result.authorizationUrl);
	});
}

async function startPrivate() {
	await perform(async () => {
		const result = await misskeyApi('gridspace/private-grant', { action: 'start', withReply: true, withNotifications: true, withActions: true });
		if (!result.authorizationUrl || !result.clientKey) throw new Error('Missing authorization URL');
		sessionStorage.setItem(storageKey, result.clientKey);
		sessionStorage.setItem(`${storageKey}:purpose`, 'private');
		window.location.assign(result.authorizationUrl);
	});
}

async function copyPalette() {
	if (!status.value?.initiator || !status.value.peerOrigin || !status.value.peerUserId) return;
	await prefer.cloudReady;
	await store.ready;
	const key = gridspacePaletteSource(status.value.peerOrigin, status.value.peerUserId);
	const paletteImported = prefer.s.gridspacePaletteImports.includes(key);
	const recentImported = store.s.gridspaceRecentEmojiImports.includes(key);
	const recentRequested = sessionStorage.getItem(`${storageKey}:recent-emojis`) === 'true';
	if (paletteImported && recentImported && !recentRequested) {
		prefer.commit('gridspacePaletteImportPending', false);
		return;
	}
	const result = await misskeyApi('gridspace/palette', {});
	if (!result.palette) {
		if (recentRequested) recentEmojiUnavailable.value = true;
		prefer.commit('gridspacePaletteImportPending', false);
		return;
	}
	if (!paletteImported && !recentRequested) {
		const merged = await mergeGridspacePalette(prefer.s.emojiPalettes, result.palette, result.peerOrigin, result.peerUserId);
		for (const setting of ['emojiPalettes', 'emojiPaletteForMain', 'emojiPaletteForReaction'] as const) prefer.setAccountOverride(setting);
		prefer.commit('emojiPalettes', merged.palettes);
		if (result.palette.palettes.length) {
			prefer.commit('emojiPaletteForMain', merged.forMain);
			prefer.commit('emojiPaletteForReaction', merged.forReaction);
		}
		prefer.commit('gridspacePaletteImports', [...prefer.s.gridspacePaletteImports, key]);
		paletteCopied.value = true;
	}
	if (!recentImported || recentRequested) {
		if (result.palette.recentlyUsedEmojis !== undefined) {
			await store.set('recentlyUsedEmojis', mergeGridspaceRecentEmojis(store.s.recentlyUsedEmojis, result.palette.recentlyUsedEmojis));
			await store.set('gridspaceRecentEmojiImports', [...new Set([...store.s.gridspaceRecentEmojiImports, key])]);
			recentEmojiCopied.value = true;
			sessionStorage.removeItem(`${storageKey}:recent-emojis`);
		} else if (recentRequested) recentEmojiUnavailable.value = true;
	}
	prefer.commit('gridspacePaletteImportPending', false);
}

async function startRecentEmojis() {
	if (busy.value) return;
	await startLink(true);
}

async function resumePalette() {
	if (!prefer.s.gridspacePaletteImportPending || status.value?.state !== 'active' || !status.value.initiator) return;
	paletteAttempted = true;
	paletteError.value = false;
	try { await copyPalette(); } catch { paletteError.value = true; }
}

async function retryPalette() {
	await perform(resumePalette);
}

async function resumeProfile() {
	await prefer.cloudReady;
	if (!prefer.s.gridspaceProfileImportPending || status.value?.state !== 'active' || !status.value.initiator || !status.value.channelsEnabled) return;
	profileAttempted = true;
	profileError.value = false;
	try {
		const result = await misskeyApi('gridspace/profile-import', {});
		profileResult.value = result;
		profileError.value = !result.complete;
		if (result.complete) prefer.commit('gridspaceProfileImportPending', false);
	} catch { profileError.value = true; }
	// The copy receipt remains successful even if refreshing the sidebar fails.
	try { updateCurrentAccount(await misskeyApi('i', {})); } catch { /* Refreshed by the next account update. */ }
}

async function retryProfile() {
	await perform(async () => {
		await prefer.cloudReady;
		prefer.commit('gridspaceProfileImportPending', true);
		await resumeProfile();
	});
}

async function startSettings() {
	await prefer.cloudReady;
	prefer.commit('gridspaceSettingsImportRequest', crypto.randomUUID());
	await start(); // The source browser exports its selected account's current display settings.
}

async function resumeSettings(retry = false) {
	await prefer.cloudReady;
	const requestId = prefer.s.gridspaceSettingsImportRequest;
	if (!requestId || settingsRunning || status.value?.state !== 'active' || !status.value.initiator || !status.value.channelsEnabled) return;
	settingsRunning = true; settingsAttempted = true; settingsError.value = false; settingsComplete.value = false;
	try {
		let result = await misskeyApi('gridspace/settings-import', { action: 'start', requestId });
		if (retry && result.failed > 0) result = await misskeyApi('gridspace/settings-import', { action: 'retry', requestId });
		if (prefer.s.gridspaceSettingsApplied !== requestId) {
			if (!result.client) throw new Error('Source settings need authorization');
			const snapshot = parseClientSettings(result.client);
			skippedSettings.value = snapshot.skipped ?? [];
			if (layoutSettingKeys.some(key => key in snapshot.values)) {
				let lists = await misskeyApi('gridspace/list-import', { action: 'start' });
				while (lists.pending && !stopped) {
					await new Promise(resolve => window.setTimeout(resolve, 1200));
					if (stopped) return;
					lists = await misskeyApi('gridspace/list-import', { action: 'step' });
				}
				const mapped = await mapLayoutSettings(snapshot.values, (kind, id) => misskeyApi('gridspace/layout-reference', { kind, id }), i18n.ts._gridspace.layoutReferenceUnavailable);
				snapshot.values = mapped.values;
				layoutIssues.value = mapped.issues;
			}
			for (const key of portableSettingKeys) {
				if (!(key in snapshot.values)) continue;
				if (!('accountDependent' in PREF_DEF[key]) || !PREF_DEF[key].accountDependent) prefer.setAccountOverride(key);
				prefer.commit(key, snapshot.values[key] as never);
			}
			if ('deck.profiles' in snapshot.values || 'deck.profile' in snapshot.values) (await import('@/deck.js')).reloadCurrentDeckProfile();
			if (snapshot.visibility !== undefined) store.set('visibility', snapshot.visibility);
			if (snapshot.localOnly !== undefined) store.set('localOnly', snapshot.localOnly);
			if (snapshot.menuDisplay !== undefined) await store.set('menuDisplay', snapshot.menuDisplay);
			if (snapshot.memos) { store.set('memo', snapshot.memos.memo); store.set('memo2', snapshot.memos.memo2); }
			prefer.commit('gridspaceSettingsApplied', requestId);
		}
		settingsResult.value = result;
		while (result.pending > 0 && !stopped) {
			await new Promise(resolve => window.setTimeout(resolve, 1200));
			if (stopped) break;
			result = await misskeyApi('gridspace/settings-import', { action: 'step', requestId });
			settingsResult.value = result;
		}
		settingsError.value = result.failed > 0;
		if (result.complete) { settingsComplete.value = true; prefer.commit('gridspaceSettingsImportRequest', null); }
		try { updateCurrentAccount(await misskeyApi('i', {})); } catch { /* Refreshed by the next account update. */ }
	} catch { settingsError.value = true; } finally { settingsRunning = false; }
}

async function retrySettings() { await perform(() => resumeSettings(true)); }

async function runPlayImport(start = false, retry = false) {
	if (playImportBusy.value || stopped || !status.value?.initiator || !status.value.channelsEnabled) return;
	playImportBusy.value = true;
	playImportError.value = false;
	try {
		let result = await misskeyApi('gridspace/play-import', { action: start ? 'start' : 'status' });
		if (!start && result.pending) result = await misskeyApi('gridspace/play-import', { action: 'start' });
		if (retry) result = await misskeyApi('gridspace/play-import', { action: 'retry' });
		playImportResult.value = result;
		while (result.pending && !stopped) {
			await new Promise(resolve => window.setTimeout(resolve, 1200));
			if (stopped) break;
			result = await misskeyApi('gridspace/play-import', { action: 'step' });
			playImportResult.value = result;
		}
		playImportError.value = result.failed > 0;
	} catch { playImportError.value = true; } finally { playImportBusy.value = false; }
}

async function revoke() {
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._gridspace.revokeConfirm });
	if (canceled) return;
	await perform(async () => {
		status.value = await misskeyApi('gridspace/link', { action: 'revoke' });
		sessionStorage.removeItem(storageKey);
		prefer.commit('gridspacePaletteImportPending', false);
		prefer.commit('gridspaceProfileImportPending', false);
		prefer.commit('gridspaceSettingsImportRequest', null);
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
				else {
					status.value = await misskeyApi('gridspace/link', input);
					const recentEmojisOnly = sessionStorage.getItem(`${storageKey}:recent-emojis`) === 'true';
					prefer.commit('gridspacePaletteImportPending', true);
					if (!recentEmojisOnly) {
						listsAutoStart.value = true;
						playImportAutoStart = true;
						prefer.commit('gridspaceProfileImportPending', true);
					} else {
						// Leave earlier migration jobs pending; this return imports only history.
						profileAttempted = true;
						settingsAttempted = true;
						skipPlayImport = true;
					}
					await resumePalette();
					if (!recentEmojisOnly) {
						await resumeProfile();
						await resumeSettings();
					}
				}
				sessionStorage.removeItem(storageKey);
				sessionStorage.removeItem(`${storageKey}:purpose`);
			});
		} else {
			error.value = i18n.ts._gridspace.authorizationError;
			sessionStorage.removeItem(`${storageKey}:recent-emojis`);
			prefer.commit('gridspacePaletteImportPending', false);
			prefer.commit('gridspaceProfileImportPending', false);
			prefer.commit('gridspaceSettingsImportRequest', null);
		}
	}
	if (!status.value) {
		try { status.value = await misskeyApi('gridspace/link', { action: 'status' }); } catch { error.value ||= i18n.ts._gridspace.connectionError; }
	}
	if (stopped) return;
	try {
		readGrant.value = await misskeyApi('gridspace/private-grant', { action: 'status' });
		if (status.value?.channelsEnabled && status.value.state === 'active') collectionsGrant.value = await misskeyApi('gridspace/collections', { kind: 'status' });
		if (status.value?.channelsEnabled && status.value.state === 'active') driveGrant.value = await misskeyApi('gridspace/drive', { mode: 'status' });
	} catch { error.value ||= i18n.ts._gridspace.connectionError; }
	if (stopped) return;
	if (!paletteAttempted) await resumePalette();
	if (!profileAttempted) await perform(resumeProfile);
	if (!settingsAttempted) await perform(() => resumeSettings());
	if (!skipPlayImport) void runPlayImport(playImportAutoStart);
	poll = window.setInterval(() => { if (status.value?.pending && !busy.value) void refresh(); }, 3000);
});
onUnmounted(() => { stopped = true; window.clearInterval(poll); });

definePage(() => ({ title: i18n.ts._gridspace.title, icon: 'ti ti-link' }));
</script>

<style lang="scss" module>
.root {
	h2 {
		margin: 0;
		font-size: 1.1em;
	}

	p {
		margin: 0;
		line-height: 1.6;
	}
}

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
