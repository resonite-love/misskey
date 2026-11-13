<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header>
		<nav :class="$style.nav" :aria-label="i18n.ts.drive">
			<button class="_button _link" @click="emit('close')">{{ i18n.ts.drive }}</button>
			<i class="ti ti-chevron-right"></i>
			<button class="_button _link" @click="openFolder(null)">{{ i18n.ts._gridspace.driveTitle }}</button>
			<template v-for="folder in path" :key="folder.id">
				<i class="ti ti-chevron-right"></i>
				<button class="_button _link" @click="openFolder(folder.id)">{{ folder.name }}</button>
			</template>
			<button class="_button" :aria-label="i18n.ts.reload" :disabled="busy" @click="openFolder(folderId)"><i class="ti ti-refresh"></i></button>
		</nav>
	</template>
	<div class="_gaps" :class="$style.content">
		<p>{{ i18n.ts._gridspace.driveDescription }}</p>
		<MkInfo v-if="needsGrant" warn>{{ i18n.ts._gridspace.driveNeedsGrant }} <MkA to="/settings/gridspace">{{ i18n.ts.settings }}</MkA></MkInfo>
		<MkInfo v-if="error" warn role="alert">{{ error }}</MkInfo>
		<MkButton v-if="error" :disabled="busy" @click="openFolder(folderId)">{{ i18n.ts.retry }}</MkButton>
		<div v-if="preview" class="_panel _gaps_s" :class="$style.preview">
			<div><b>{{ preview.name }}</b> <button class="_button" :aria-label="i18n.ts.close" @click="preview = null"><i class="ti ti-x"></i></button></div>
			<MkMediaList :mediaList="[displayFile(preview)]" :raw="true" ephemeral/>
			<div class="_buttons">
				<a :href="preview.url" :download="preview.name" target="_blank" rel="noopener noreferrer" class="_link">{{ i18n.ts.download }}</a>
				<MkButton :disabled="importing !== null" @click="attach(preview, true)">{{ i18n.ts.createNoteFromTheFile }}</MkButton>
			</div>
		</div>
		<div :class="$style.grid">
			<button v-for="folder in folders" :key="folder.id" class="_button" :aria-label="folder.name" @click="openFolder(folder.id)"><XFolder :folder="displayFolder(folder)" readOnly/></button>
		</div>
		<div :class="$style.grid">
			<button v-for="file in files" :key="file.id" class="_button" :aria-label="file.name" :disabled="importing !== null || (excludeSensitive && file.isSensitive)" @click="select ? attach(file) : preview = file">
				<XFile :file="displayFile(file)" :folder="null" :isSelected="!!selectedFile(file)" :isDisabled="excludeSensitive && file.isSensitive" readOnly/>
				<MkLoading v-if="importing === file.id"/>
			</button>
		</div>
		<MkLoading v-if="busy"/>
		<MkButton v-if="more && !needsGrant" :disabled="busy" @click="load(true)">{{ i18n.ts.loadMore }}</MkButton>
		<MkResult v-if="!busy && !error && !needsGrant && files.length === 0 && folders.length === 0" type="empty"/>
	</div>
</MkStickyContainer>
</template>

<script setup lang="ts">
import { onActivated, onDeactivated, onBeforeUnmount, onMounted, ref } from 'vue';
import XFile from './MkDrive.file.vue';
import XFolder from './MkDrive.folder.vue';
import MkButton from './MkButton.vue';
import MkInfo from './MkInfo.vue';
import MkMediaList from './MkMediaList.vue';
import type { entities } from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { globalEvents } from '@/events.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';

const props = defineProps<{ select?: boolean; selected: entities.DriveFile[]; excludeSensitive?: boolean; type?: string }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'selected', file: entities.DriveFile): void }>();
const files = ref<entities.DriveFile[]>([]), folders = ref<entities.DriveFolder[]>([]), path = ref<entities.DriveFolder[]>([]);
const folderId = ref<string | null>(null), preview = ref<entities.DriveFile | null>(null);
const busy = ref(false), needsGrant = ref(false), error = ref(''), more = ref(false), importing = ref<string | null>(null);
let generation = 0, active = true;
let timer: number | undefined;

function displayFile(file: entities.DriveFile): entities.DriveFile { return { ...file, id: `gridspace-drive:${file.id}`, folderId: null, folder: null, userId: null, user: null }; }

function displayFolder(folder: entities.DriveFolder): entities.DriveFolder { return { ...folder, id: `gridspace-drive:${folder.id}`, parentId: null, parent: undefined }; }

function selectedFile(file: entities.DriveFile) { return props.selected.find(item => item.md5 === file.md5 && item.name === file.name && item.comment === file.comment && (!file.isSensitive || item.isSensitive)); }

function clear() { generation++; files.value = []; folders.value = []; path.value = []; preview.value = null; more.value = false; busy.value = false; }

async function openFolder(id: string | null) { folderId.value = id; clear(); await load(); }

async function load(append = false) {
	if (busy.value || !active || window.document.hidden) return;
	const current = generation;
	busy.value = true; error.value = '';
	try {
		const page = await misskeyApi('gridspace/drive', { mode: 'list', folderId: folderId.value, type: props.type, limit: 30, filesBefore: append ? files.value.at(-1)?.id : undefined, foldersBefore: append ? folders.value.at(-1)?.id : undefined }, undefined, AbortSignal.timeout(15000));
		if (current !== generation) return;
		needsGrant.value = !page.granted;
		files.value = append ? [...new Map([...files.value, ...page.files].map(file => [file.id, file])).values()] : page.files;
		folders.value = append ? [...new Map([...folders.value, ...page.folders].map(folder => [folder.id, folder])).values()] : page.folders;
		path.value = page.path;
		more.value = !!(page.filesNext || page.foldersNext);
	} catch (err) {
		if (current !== generation) return;
		clear();
		needsGrant.value = ['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes((err as { info?: { reason?: string } }).info?.reason ?? '');
		if (!needsGrant.value) error.value = i18n.ts._gridspace.driveError;
	} finally { if (current === generation) busy.value = false; }
}

async function attach(file: entities.DriveFile, post = false) {
	if (importing.value || (props.excludeSensitive && file.isSensitive)) return;
	const current = generation;
	importing.value = file.id;
	try {
		const existing = selectedFile(file);
		const local = existing ?? await misskeyApi('gridspace/drive-import', { fileId: file.id }, undefined, AbortSignal.timeout(90000));
		if (!local) throw new Error('Missing imported file');
		if (current !== generation) return;
		globalEvents.emit('driveFileCreated', local);
		if (post) os.post({ initialFiles: [local] }); else emit('selected', local);
	} catch { if (current === generation) await os.alert({ type: 'error', text: i18n.ts._gridspace.driveImportError }); } finally { importing.value = null; }
}

async function checkGrant() {
	if (!active || window.document.hidden || busy.value) return;
	const current = generation;
	try {
		const status = await misskeyApi('gridspace/drive', { mode: 'status' }, undefined, AbortSignal.timeout(15000));
		if (current !== generation) return;
		if (!status.granted) { clear(); needsGrant.value = true; }
	} catch { if (current === generation) { clear(); error.value = i18n.ts._gridspace.driveError; } }
}

function visibility() { if (window.document.hidden) clear(); else void load(); }

onMounted(() => { void load(); window.document.addEventListener('visibilitychange', visibility); timer = window.setInterval(() => void checkGrant(), 15000); });
onActivated(() => { if (!active) { active = true; void load(); } });
onDeactivated(() => { active = false; clear(); });
onBeforeUnmount(() => { active = false; clear(); window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); });
</script>

<style lang="scss" module>
.nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 16px; background: var(--MI_THEME-bg); }
.content { padding: 16px 32px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.preview { padding: 16px; max-width: 600px; }
@container (max-width: 600px) { .content { padding: 16px; } }
</style>
