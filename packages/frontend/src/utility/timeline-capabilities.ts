/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Only the explicitly advertised surface may replace its legacy reader. */
export function supportsTimelineKind(status: unknown, kind: string): boolean {
	if (status == null || typeof status !== 'object' || !('timeline' in status)) return false;
	const value = status.timeline;
	if (value == null || typeof value !== 'object') return false;
	const capability = value as { version?: unknown; enabled?: unknown; kinds?: unknown };
	return capability.version === 1 && capability.enabled === true && Array.isArray(capability.kinds) && capability.kinds.includes(kind);
}
