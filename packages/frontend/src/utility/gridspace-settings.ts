/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { PREF_DEF } from '@/preferences/def.js';
import type { PreferencesProfile } from '@/preferences/manager.js';
import { layoutSettingKeys, validLayoutSetting } from './gridspace-layout.js';

// Display/composer preferences and layout snapshots only. Resource IDs in layouts
// are remapped through the authenticated bridge before applying them. Never transfer
// accounts, plugins, credentials, or migration receipts.
export const portableSettingKeys = [
	'autoTranslation.enabled', 'autoTranslation.targetLang', 'defaultNoteVisibility', 'defaultNoteLocalOnly', 'keepCw', 'rememberNoteVisibility',
	'syncDeviceDarkMode', 'collapseRenotes', 'serverDisconnectedBehavior', 'nsfw', 'highlightSensitiveMedia', 'animation', 'animatedMfm', 'advancedMfm',
	'showReactionsCount', 'enableQuickAddMfmFunction', 'loadRawImages', 'imageNewTab', 'disableShowingAnimatedImages', 'emojiStyle', 'menuStyle',
	'useBlurEffectForModal', 'useBlurEffect', 'useStickyIcons', 'enableHighQualityImagePlaceholders', 'showFixedPostForm', 'showFixedPostFormInChannel',
	'enableInfiniteScroll', 'useReactionPickerForContextMenu', 'instanceTicker', 'emojiPickerScale', 'emojiPickerWidth', 'emojiPickerHeight', 'emojiPickerStyle',
	'squareAvatars', 'showAvatarDecorations', 'showNoteActionsOnlyHover', 'showClipButtonInNoteFooter', 'reactionsDisplaySize', 'limitWidthOfReaction',
	'mediaListWithOneImageAppearance', 'showMediaListByGridInWideArea', 'notificationPosition', 'notificationStackAxis', 'useGroupedNotifications',
	'autoplayEmbededPlayerOfUrlPreview', 'enableSeasonalScreenEffect', 'enableHorizontalSwipe', 'enablePullToRefresh', 'useNativeUiForVideoAudioPlayer',
	'keepOriginalFilename', 'alwaysConfirmFollow', 'confirmWhenRevealingSensitiveMedia', 'contextMenu', 'skipNoteRender', 'showSoftWordMutedWord',
	'confirmOnReact', 'defaultFollowWithReplies', 'sound.masterVolume', 'sound.notUseSound', 'sound.useSoundOnlyWhenActive',
	'deck.alwaysShowMainColumn', 'deck.navWindow', 'deck.useSimpleUiForNonRootPages', 'deck.columnAlign', 'deck.columnGap', 'deck.menuPosition', 'deck.navbarPosition',
	'chat.showSenderName', 'chat.sendOnEnter', 'themes', 'lightTheme', 'darkTheme', 'dataSaver',
	'menu', 'mutingEmojis', 'imageFramePresets', 'defaultWatermarkPresetId', 'defaultImageCompressionLevel', 'defaultVideoCompressionLevel',
	'sound.on.note', 'sound.on.noteMy', 'sound.on.notification', 'sound.on.reaction', 'sound.on.chatMessage',
	...layoutSettingKeys,
] as const satisfies readonly (keyof typeof PREF_DEF)[];
type Key = typeof portableSettingKeys[number];
type Scope = PreferencesProfile['preferences']['animation'][number][0];
export type ClientSettings = { version: 1; values: Partial<Record<Key, unknown>>; visibility?: 'public' | 'home' | 'followers' | 'specified'; localOnly?: boolean; menuDisplay?: 'sideFull' | 'sideIcon'; memos?: { memo: string | null; memo2: string | null }; skipped?: Key[] };
const visibilities = ['public', 'home', 'followers', 'specified'];
const stringOptions: Partial<Record<Key, readonly string[]>> = {
	defaultNoteVisibility: visibilities, serverDisconnectedBehavior: ['quiet', 'reload', 'dialog'], nsfw: ['respect', 'force', 'ignore'],
	emojiStyle: ['native', 'fluentEmoji', 'twemoji'], menuStyle: ['auto', 'popup', 'drawer'], instanceTicker: ['none', 'remote', 'always'],
	emojiPickerStyle: ['auto', 'popup', 'drawer'], reactionsDisplaySize: ['small', 'medium', 'large'], mediaListWithOneImageAppearance: ['expand', '16_9', '1_1', '2_3'],
	notificationPosition: ['leftTop', 'leftBottom', 'rightTop', 'rightBottom'], notificationStackAxis: ['vertical', 'horizontal'], contextMenu: ['app', 'appWithShift', 'native'],
	'deck.columnAlign': ['left', 'center'], 'deck.menuPosition': ['right', 'bottom'], 'deck.navbarPosition': ['left', 'top', 'bottom'],
};
const numberKeys: readonly Key[] = ['emojiPickerScale', 'emojiPickerWidth', 'emojiPickerHeight', 'sound.masterVolume', 'deck.columnGap'];

/** Cache only within one consent attempt and keep the selected account's scope. */
export function createGridspacePreferenceReader(loadAll: () => Promise<Record<string, unknown>>, sameScope: (a: Scope, b: Scope) => boolean) {
	let cloud: Promise<Record<string, unknown>> | undefined;
	return async (key: string, scope: Scope): Promise<{ value: unknown } | null> => {
		cloud ??= loadAll();
		const values = (await cloud)[`default:${key}`];
		if (values === undefined) return null;
		if (!Array.isArray(values)) throw new Error('Invalid synced preference');
		const target = values.find(row => Array.isArray(row) && row[0] && sameScope(row[0], scope));
		return target ? { value: target[1] } : null;
	};
}

function theme(value: unknown): boolean {
	if (value === null) return true;
	if (!value || typeof value !== 'object') return false;
	const t = value as Record<string, unknown>;
	return typeof t.id === 'string' && typeof t.name === 'string' && (t.base === undefined || ['light', 'dark'].includes(t.base as string)) && !!t.props && typeof t.props === 'object' && !Array.isArray(t.props) &&
		Object.entries(t.props).length < 500 && Object.values(t.props).every(v => typeof v === 'string' && v.length < 4096);
}

export function parseClientSettings(raw: string): ClientSettings {
	if (raw.length > 524288) throw new Error('Settings too large');
	const input = JSON.parse(raw);
	if (!input || input.version !== 1 || !input.values || typeof input.values !== 'object' || (input.visibility !== undefined && !visibilities.includes(input.visibility)) || (input.localOnly !== undefined && typeof input.localOnly !== 'boolean')) throw new Error('Invalid settings');
	const values: ClientSettings['values'] = {};
	for (const key of portableSettingKeys) {
		if (!(key in input.values)) continue;
		const value = input.values[key];
		let valid: boolean;
		if ((layoutSettingKeys as readonly string[]).includes(key)) valid = validLayoutSetting(key, value);
		else if (key === 'menu') valid = Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && /^(?:-|[a-zA-Z][a-zA-Z0-9_-]{0,99})$/.test(item));
		else if (key === 'mutingEmojis') valid = Array.isArray(value) && value.length <= 10000 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 512);
		else if (key === 'defaultWatermarkPresetId') valid = value === null || typeof value === 'string' && value.length > 0 && value.length <= 128;
		else if (key === 'defaultImageCompressionLevel' || key === 'defaultVideoCompressionLevel') valid = [0, 1, 2, 3].includes(value);
		else if (key === 'imageFramePresets') valid = validImageFramePresets(value);
		else if (key === 'themes') valid = Array.isArray(value) && value.length <= 100 && value.every(t => t !== null && theme(t));
		else if (key === 'lightTheme' || key === 'darkTheme') valid = theme(value);
		else if (key.startsWith('sound.on.')) valid = value && (value.type === null || typeof value.type === 'string') && value.type !== '_driveFile_' && typeof value.volume === 'number' && value.volume >= 0 && value.volume <= 1;
		else if (key === 'dataSaver') valid = value && ['media', 'avatar', 'urlPreviewThumbnail', 'disableUrlPreview', 'code'].every(k => typeof value[k] === 'boolean');
		else if (key === 'autoTranslation.targetLang') valid = typeof value === 'string' && value.length <= 256;
		else if (stringOptions[key]) valid = stringOptions[key]!.includes(value);
		else if (numberKeys.includes(key)) valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= (key === 'sound.masterVolume' ? 1 : 10000);
		else valid = typeof value === 'boolean';
		if (!valid) throw new Error(`Invalid portable preference: ${key}`);
		values[key] = value;
	}
	if (input.memos && !['memo', 'memo2'].every(key => input.memos[key] === null || typeof input.memos[key] === 'string' && input.memos[key].length <= 65536)) throw new Error('Invalid memo');
	if (input.skipped !== undefined && (!Array.isArray(input.skipped) || input.skipped.length > portableSettingKeys.length || input.skipped.some((key: unknown) => !(portableSettingKeys as readonly unknown[]).includes(key)))) throw new Error('Invalid skipped preferences');
	if (input.menuDisplay !== undefined && !['sideFull', 'sideIcon'].includes(input.menuDisplay)) throw new Error('Invalid sidebar mode');
	return { version: 1, values, visibility: input.visibility, localOnly: input.localOnly, menuDisplay: input.menuDisplay, memos: input.memos, skipped: input.skipped };
}

function validImageFramePresets(value: unknown): boolean {
	if (!Array.isArray(value) || value.length > 100) return false;
	const color = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1);
	const label = (v: any) => v && typeof v.enabled === 'boolean' && typeof v.centered === 'boolean' && typeof v.withQrCode === 'boolean' &&
		typeof v.textBig === 'string' && v.textBig.length <= 65536 && typeof v.textSmall === 'string' && v.textSmall.length <= 65536 &&
		[v.scale, v.padding].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10000);
	return value.every(preset => preset && typeof preset.id === 'string' && preset.id.length <= 128 && typeof preset.name === 'string' && preset.name.length <= 256 && preset.params &&
		['serif', 'sans-serif'].includes(preset.params.font) && color(preset.params.bgColor) && color(preset.params.fgColor) && label(preset.params.labelTop) && label(preset.params.labelBottom) &&
		[preset.params.borderThickness, preset.params.borderRadius].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10000));
}

export async function snapshotClientSettings(profile: PreferencesProfile, server: string, account: string, activeAccount: string | undefined,
	load: (key: Key, scope: Scope) => Promise<{ value: unknown } | null>, remembered: { visibility: string; localOnly: boolean; menuDisplay?: string; memo?: string | null; memo2?: string | null }): Promise<string> {
	const values: ClientSettings['values'] = {};
	const skipped: Key[] = [];
	// Sequential cloud reads keep authorization from generating a request burst.
	for (const key of portableSettingKeys) {
		const records = profile.preferences[key] ?? [];
		const record = records.find(([s]) => s.server === server && s.account === account) ?? records.find(([s]) => s.server === server && s.account == null) ?? records.find(([s]) => s.server == null && s.account == null);
		if (!record) continue;
		let value: unknown = record[1];
		if (record[2].sync) {
			const remote = await load(key, record[0]);
			if (remote) value = remote.value;
			else if (activeAccount !== account && record[0].account !== account) continue;
		} else if (activeAccount !== account && record[0].account !== account) continue;
		if (key.startsWith('sound.on.') && (value as { type?: string })?.type === '_driveFile_') continue;
		// Older clients have no `code` data-saver field; missing flags behave as false.
		if (key === 'dataSaver' && value && typeof value === 'object' && !Array.isArray(value)) {
			value = { media: false, avatar: false, urlPreviewThumbnail: false, disableUrlPreview: false, code: false, ...value };
		}
		try {
			parseClientSettings(JSON.stringify({ version: 1, values: { [key]: value } }));
		} catch {
			// A stale optional UI value must not prevent account authorization.
			// Do not weaken posting privacy defaults on a malformed source setting.
			if (key === 'defaultNoteVisibility' || key === 'defaultNoteLocalOnly') throw new Error(`Invalid portable preference: ${key}`);
			skipped.push(key);
			continue;
		}
		values[key] = value;
	}
	if (values.defaultWatermarkPresetId && !(values.watermarkPresets as { id: string }[] | undefined)?.some(preset => preset.id === values.defaultWatermarkPresetId)) {
		delete values.defaultWatermarkPresetId; skipped.push('defaultWatermarkPresetId');
	}
	const visibility = activeAccount === account ? remembered.visibility : values.defaultNoteVisibility;
	const localOnly = activeAccount === account ? remembered.localOnly : values.defaultNoteLocalOnly;
	const memos = activeAccount === account && remembered.memo !== undefined && remembered.memo2 !== undefined ? { memo: remembered.memo, memo2: remembered.memo2 } : undefined;
	return JSON.stringify(parseClientSettings(JSON.stringify({ version: 1, values, visibility, localOnly, menuDisplay: remembered.menuDisplay, memos, ...(skipped.length ? { skipped } : {}) })));
}
