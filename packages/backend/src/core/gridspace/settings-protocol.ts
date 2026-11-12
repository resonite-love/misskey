/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Explicitly exclude credentials, identities, roles, media IDs and ownership. */
export const accountSettingKeys = [
	'lang', 'isLocked', 'isExplorable', 'hideOnlineStatus', 'publicReactions', 'carefulBot', 'autoAcceptFollowed',
	'followApprovalLocalSeconds', 'followApprovalRemoteSeconds', 'noCrawle', 'preventAiLearning', 'requireSigninToViewContents',
	'isBot', 'isCat', 'injectFeaturedNote', 'alwaysMarkNsfw', 'autoSensitive', 'followingVisibility', 'followersVisibility',
	'chatScope', 'mutedWords', 'hardMutedWords', 'mutedInstances', 'notificationRecieveConfig',
] as const;
export const settingsScope = ['client', 'gridspace'];
export const settingsKey = 'migrationSettings';
// OAuth registry requests are confined to their access-token ID domain.
// This reserved domain also suppresses registryUpdated streaming broadcasts.
export const settingsDomain = 'gridspace.settings.internal';
export type SettingsSnapshot = {
	account: Record<string, unknown>;
	client: string | null;
	restrictions: { kind: 'mute' | 'block'; uri: string; expiresAt: number | null }[];
};
export function selectAccountSettings(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(accountSettingKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
export function parseSettingsSnapshot(value: unknown): SettingsSnapshot {
	if (!value || typeof value !== 'object') throw new Error('Invalid settings');
	const p = value as SettingsSnapshot;
	if (!p.account || typeof p.account !== 'object' || Array.isArray(p.account) || !Array.isArray(p.restrictions) || p.restrictions.length > 20000 ||
		(p.client !== null && (typeof p.client !== 'string' || p.client.length > 524288))) throw new Error('Invalid settings');
	return { account: selectAccountSettings(p.account), client: p.client, restrictions: p.restrictions.map(item => {
		if (!item || !['mute', 'block'].includes(item.kind) || typeof item.uri !== 'string' || item.uri.length > 4096 ||
			(item.expiresAt !== null && (!Number.isSafeInteger(item.expiresAt) || item.expiresAt < 0))) throw new Error('Invalid restriction');
		const url = new URL(item.uri);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid actor');
		return { kind: item.kind, uri: item.uri, expiresAt: item.expiresAt };
	}) };
}
