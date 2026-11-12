<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer" style="--MI_SPACER-w: 1000px;">
		<div class="_gaps">
			<MkInfo>{{ t.description }}</MkInfo>
			<MkInfo v-if="error" warn role="alert">{{ t.loadFailed }}</MkInfo>
			<div class="_buttons">
				<MkButton :disabled="loading" @click="refresh">{{ i18n.ts.reload }}</MkButton>
				<MkA to="/admin/modlog">{{ t.auditLog }}</MkA>
			</div>
			<MkLoading v-if="!status && loading"/>
			<template v-if="status">
				<section class="_panel _gaps_s" :class="$style.section">
					<h2>{{ t.connection }}</h2>
					<div>{{ status.origin }} → {{ status.peerOrigin ?? t.disabled }}</div>
					<strong :class="status.connection !== 'ok' ? $style.warning : undefined">{{ connectionLabel(status.connection) }}</strong>
					<div>{{ t.checkedAt }}: <MkTime :time="status.checkedAt" mode="absolute"/> <span v-if="status.latencyMs !== null">({{ status.latencyMs }} ms)</span></div>
					<small>{{ t.connectionHint }}</small>
				</section>
				<div :class="$style.metrics">
					<section class="_panel" :class="$style.section">
						<h2>{{ t.links }}</h2>
						<dl :class="$style.counts"><dt>{{ t.active }}</dt><dd>{{ status.linksActive }}</dd><dt>{{ t.preparing }}</dt><dd>{{ status.linksPreparing }}</dd><dt>{{ t.revoked }}</dt><dd>{{ status.linksRevoked }}</dd><dt>{{ t.errors }}</dt><dd>{{ status.linksWithErrors }}</dd></dl>
					</section>
					<section class="_panel" :class="$style.section">
						<h2>{{ t.follows }}</h2>
						<dl :class="$style.counts"><dt>{{ t.importPending }}</dt><dd>{{ status.importsPending }}</dd><dt>{{ t.importFailed }}</dt><dd>{{ status.importsFailed }}</dd><dt>{{ t.requested }}</dt><dd>{{ status.importsRequested }}</dd><dt>{{ t.expansionPending }}</dt><dd>{{ status.expansionsPending }}</dd><dt>{{ t.expansionRetrying }}</dt><dd>{{ status.expansionsRetrying }}</dd></dl>
					</section>
					<section class="_panel" :class="$style.section">
						<h2>{{ t.delivery }}</h2>
						<dl :class="$style.counts"><dt>{{ t.pending }}</dt><dd>{{ status.deliveriesPending }}</dd><dt>{{ t.retrying }}</dt><dd>{{ status.deliveriesRetrying }}</dd><dt>{{ t.revokePending }}</dt><dd>{{ status.revocationsPending }}</dd><dt>{{ t.privateRevokePending }}</dt><dd>{{ status.privateRevocationsPending }}</dd></dl>
					</section>
				</div>
			</template>

			<MkFolder :defaultOpen="true">
				<template #label>{{ t.links }}</template>
				<div class="_gaps">
					<MkInput v-model="userId" :ariaLabel="t.userFilter" :disabled="loading"><template #label>{{ t.userFilter }}</template></MkInput>
					<MkSwitch v-model="issuesOnly" :disabled="loading">{{ t.issuesOnly }}</MkSwitch>
					<MkButton :disabled="loading" @click="refresh">{{ t.applyFilter }}</MkButton>
					<p v-if="links.length === 0">{{ t.noLinks }}</p>
					<article v-for="link in links" :key="link.id" :class="$style.item">
						<div><MkA :to="`/admin/user/${link.localUserId}`">@{{ link.localUsername }}</MkA> ↔ @{{ link.peerUsername }}@{{ host(link.peerOrigin) }}</div>
						<div>{{ stateLabel(link.state) }} · {{ link.initiator ? t.initiator : t.mirror }} · {{ t.generation }} {{ link.generation }}</div>
						<div v-if="link.lastError" :class="$style.warning">{{ reasonLabel(link.lastError) }} <code>{{ link.lastError }}</code></div>
						<div v-if="link.privateRevocationPending" :class="$style.warning">{{ t.privateRevokePending }}</div>
						<div class="_buttons">
							<MkButton small :disabled="loading" @click="filterUser(link.localUserId)">{{ t.showJobs }}</MkButton>
							<MkButton small @click="contact(link)">{{ t.contactUser }}</MkButton>
						</div>
					</article>
					<div class="_buttons"><MkButton v-if="linksAfter" :disabled="loading" @click="loadLinks()">{{ t.firstPage }}</MkButton><MkButton v-if="linksNext" :disabled="loading" @click="loadLinks(linksNext)">{{ i18n.ts.next }}</MkButton></div>
				</div>
			</MkFolder>

			<MkFolder :defaultOpen="true">
				<template #label>{{ t.jobs }}</template>
				<div class="_gaps">
					<MkInfo>{{ t.retryHint }}</MkInfo>
					<MkSelect v-model="kind" :items="kindItems" :disabled="loading"><template #label>{{ t.jobKind }}</template></MkSelect>
					<MkSwitch v-model="failedOnly" :disabled="loading">{{ t.failedOnly }}</MkSwitch>
					<MkButton :disabled="loading" @click="loadJobs()">{{ i18n.ts.reload }}</MkButton>
					<p v-if="jobs.length === 0">{{ t.noJobs }}</p>
					<article v-for="job in jobs" :key="job.id" :class="$style.item">
						<div v-if="job.localUserId"><MkA :to="`/admin/user/${job.localUserId}`">@{{ job.localUsername }}</MkA></div>
						<div>{{ t.target }}: <span class="_selectable">{{ job.target ?? job.id }}</span></div>
						<div>{{ stateLabel(job.state) }}<span v-if="job.attempts"> · {{ t.attempts }}: {{ job.attempts }}</span></div>
						<div v-if="job.reason" :class="$style.warning">{{ reasonLabel(job.reason) }} <code>{{ job.reason }}</code></div>
						<div v-if="job.retryAt && job.state === 'pending'">{{ t.nextAttempt }}: <MkTime :time="job.retryAt" mode="absolute"/></div>
						<MkButton v-if="job.canRetry" small :disabled="busy || loading" @click="retry(job)">{{ t.retry }}</MkButton>
					</article>
					<div class="_buttons"><MkButton v-if="jobsAfter" :disabled="loading" @click="loadJobs()">{{ t.firstPage }}</MkButton><MkButton v-if="jobsNext" :disabled="loading" @click="loadJobs(jobsNext)">{{ i18n.ts.next }}</MkButton></div>
				</div>
			</MkFolder>

			<section ref="composer" class="_panel _gaps" :class="$style.section">
				<h2>{{ t.notice }}</h2>
				<MkInfo>{{ t.noticeHint }}</MkInfo>
				<MkSelect v-model="audience" :items="audienceItems" :disabled="busy"><template #label>{{ t.audience }}</template></MkSelect>
				<div v-if="audience === 'user'">{{ recipient ? `@${recipient.localUsername}` : t.chooseUser }}</div>
				<MkInput v-model="title" :ariaLabel="i18n.ts.title" :disabled="busy"><template #label>{{ i18n.ts.title }}</template></MkInput>
				<MkTextarea v-model="message" :ariaLabel="i18n.ts.text" mfmAutocomplete :mfmPreview="true" :disabled="busy"><template #label>{{ i18n.ts.text }}</template></MkTextarea>
				<MkSelect v-model="display" :items="displayItems" :disabled="busy"><template #label>{{ i18n.ts.display }}</template></MkSelect>
				<MkButton primary :disabled="busy || !title.trim() || !message.trim() || (audience === 'user' && !recipient)" @click="sendNotice">{{ t.publishNotice }}</MkButton>
				<MkA :to="recipient && audience === 'user' ? `/admin/user/${recipient.localUserId}` : '/admin/announcements'">{{ t.manageNotices }}</MkA>
			</section>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Endpoints } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';

type Status = Endpoints['admin/gridspace/status']['res'];
type Link = Endpoints['admin/gridspace/links']['res']['items'][number];
type Job = Endpoints['admin/gridspace/jobs']['res']['items'][number];
const t = i18n.ts._gridspaceAdmin;
const status = ref<Status | null>(null);
const links = ref<Link[]>([]);
const jobs = ref<Job[]>([]);
const linksAfter = ref<string>(); const linksNext = ref<string | null>(null);
const jobsAfter = ref<string>(); const jobsNext = ref<string | null>(null);
const loading = ref(false); const busy = ref(false);
const summaryError = ref(false); const linksError = ref(false); const jobsError = ref(false);
const error = computed(() => summaryError.value || linksError.value || jobsError.value);
const userId = ref(''); const issuesOnly = ref(false); const failedOnly = ref(true);
const kind = ref<Job['kind']>('import');
const kindItems = computed(() => [{ value: 'import', label: t.imports }, { value: 'expansion', label: t.expansions }, { value: 'delivery', label: t.delivery }]);
const composer = ref<HTMLElement>();
const recipient = ref<Link | null>(null);
const audience = ref<'user' | 'all'>('user');
const audienceItems = [{ value: 'user', label: t.oneUser }, { value: 'all', label: t.allUsers }];
const display = ref<'normal' | 'banner'>('normal');
const displayItems = [{ value: 'normal', label: i18n.ts.normal }, { value: 'banner', label: i18n.ts.banner }];
const title = ref(t.noticeTitle); const message = ref('');
let disposed = false;
let timer: number | undefined;

function host(origin: string) { return new URL(origin).host; }

function connectionLabel(value: Status['connection']) { return { ok: t.connected, unavailable: t.unavailable, incompatible: t.incompatible, disabled: t.disabled }[value]; }

function stateLabel(value: string) { return ({ active: t.active, preparing: t.preparing, revoked: t.revoked, pending: t.pending, requested: t.requested, done: t.done, skipped: t.skipped, failed: t.failed, cancelled: t.cancelled } as Record<string, string>)[value] ?? value; }

function reasonLabel(value: string) {
	if (['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(value)) return t.needsAuthorization;
	if (value === 'REVOKE_PENDING') return t.revokePending;
	if (value === 'USER_UNFOLLOWED') return t.manualCancellation;
	if (['TARGET_RESTRICTED', 'SOURCE_RESTRICTED', 'UNAVAILABLE'].includes(value)) return t.restricted;
	return t.checkFailure;
}

async function summary() {
	try {
		const result = await misskeyApi('admin/gridspace/status', {});
		if (!disposed) { status.value = result; summaryError.value = false; }
	} catch (failure) { if (!disposed) summaryError.value = true; throw failure; }
}

async function fetchLinks(after?: string) {
	try {
		const result = await misskeyApi('admin/gridspace/links', { after, userId: userId.value.trim() || undefined, issuesOnly: issuesOnly.value, limit: 20 });
		if (!disposed) { links.value = result.items; linksNext.value = result.next; linksAfter.value = after; linksError.value = false; }
	} catch (failure) { if (!disposed) linksError.value = true; throw failure; }
}

async function fetchJobs(after?: string) {
	try {
		const result = await misskeyApi('admin/gridspace/jobs', { kind: kind.value, after, userId: userId.value.trim() || undefined, failedOnly: failedOnly.value, limit: 20 });
		if (!disposed) { jobs.value = result.items; jobsNext.value = result.next; jobsAfter.value = after; jobsError.value = false; }
	} catch (failure) { if (!disposed) jobsError.value = true; throw failure; }
}

async function load(action: () => Promise<unknown>) {
	if (loading.value) return;
	loading.value = true;
	try { await action(); } catch { /* Each panel retains its own failure until a successful refresh. */ } finally { if (!disposed) loading.value = false; }
}

function refresh() { return load(() => Promise.allSettled([summary(), fetchLinks(), fetchJobs()])); }

function loadLinks(after?: string) { return load(() => fetchLinks(after)); }

function loadJobs(after?: string) { return load(() => fetchJobs(after)); }

function filterUser(id: string) { userId.value = id; return refresh(); }

function contact(link: Link) { if (busy.value) return; recipient.value = link; audience.value = 'user'; composer.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

async function retry(job: Job) {
	if (busy.value) return;
	busy.value = true;
	try {
		const { canceled } = await os.confirm({ type: 'warning', title: t.retry, text: t.retryConfirm });
		if (canceled) return;
		const result = await os.apiWithDialog('admin/gridspace/retry', { kind: job.kind, id: job.id, generation: job.generation ?? undefined, version: job.version ?? undefined });
		if (!result.retried) await os.alert({ type: 'info', text: t.alreadyChanged });
		await refresh();
	} catch { /* apiWithDialog has displayed the failure. */ } finally { busy.value = false; }
}

async function sendNotice() {
	if (busy.value || !title.value.trim() || !message.value.trim() || (audience.value === 'user' && !recipient.value)) return;
	busy.value = true;
	const target = audience.value === 'user' ? recipient.value : null;
	const content = { title: title.value.trim(), text: message.value.trim(), imageUrl: null, userId: target?.localUserId ?? null, display: display.value, icon: 'info' as const };
	try {
		const { canceled } = await os.confirm({ type: 'warning', title: `${t.publishNotice}: ${target ? `@${target.localUsername}` : t.allUsers}`, text: `${content.title}\n\n${content.text}` });
		if (canceled) return;
		await os.apiWithDialog('admin/announcements/create', content);
		message.value = '';
	} catch { /* apiWithDialog has displayed the failure; never retry a message automatically. */ } finally { busy.value = false; }
}

onMounted(() => {
	void refresh();
	timer = window.setInterval(() => { if (!window.document.hidden && !loading.value && !busy.value) void load(summary); }, 30_000);
});
onUnmounted(() => { disposed = true; window.clearInterval(timer); });
definePage(() => ({ title: t.title, icon: 'ti ti-link' }));
</script>

<style lang="scss" module>
.section { padding: 20px; overflow-wrap: anywhere; }
.section h2 { font-size: 1em; margin: 0 0 12px; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 12px; }
.counts { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; margin: 0; }
.counts dd { margin: 0; font-variant-numeric: tabular-nums; }
.item { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-bottom: solid 1px var(--MI_THEME-divider); overflow-wrap: anywhere; }
.warning { color: var(--MI_THEME-warn); }
</style>
