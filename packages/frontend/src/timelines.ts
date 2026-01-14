/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { $i } from '@/i.js';
import { instance } from '@/instance.js';

export const basicTimelineTypes = [
	'home',
	'local',
	'social',
	'global',
	'rl-relay',
	'rl-relay-social',
	'vmimi-relay',
	'vmimi-relay-social',
] as const;

export type BasicTimelineType = typeof basicTimelineTypes[number];

export function isBasicTimeline(timeline: string): timeline is BasicTimelineType {
	return basicTimelineTypes.includes(timeline as BasicTimelineType);
}

export function basicTimelineIconClass(timeline: BasicTimelineType): string {
	switch (timeline) {
		case 'home':
			return 'ti ti-home';
		case 'local':
			return 'ti ti-planet';
		case 'social':
			return 'ti ti-universe';
		case 'global':
			return 'ti ti-whirl';
		case 'rl-relay':
			return 'ti ti-rocket';
		case 'rl-relay-social':
			return 'ti ti-heart';
		case 'vmimi-relay':
			return 'ti ti-circles-relation';
		case 'vmimi-relay-social':
			return 'ti ti-topology-full';
	}
}

export function isAvailableBasicTimeline(timeline: BasicTimelineType | undefined | null): boolean {
	switch (timeline) {
		case 'home':
			return $i != null;
		case 'local':
			return ($i == null && instance.policies.ltlAvailable) || ($i != null && $i.policies.ltlAvailable);
		case 'social':
			return $i != null && $i.policies.ltlAvailable;
		case 'global':
			return ($i == null && instance.policies.gtlAvailable) || ($i != null && $i.policies.gtlAvailable);
		case 'rl-relay':
			return (instance.policies.gtlAvailable);
		case 'rl-relay-social':
			return $i != null && instance.policies.gtlAvailable;
		case 'vmimi-relay':
			return ($i == null && instance.policies.vrtlAvailable) || ($i != null && $i.policies.vrtlAvailable);
		case 'vmimi-relay-social':
			return $i != null && $i.policies.vrtlAvailable;
		default:
			return false;
	}
}

export function availableBasicTimelines(): BasicTimelineType[] {
	const tl = basicTimelineTypes.filter(isAvailableBasicTimeline);
	console.log('tl', tl);
	return tl;
}

export function hasWithReplies(timeline: BasicTimelineType | undefined | null): boolean {
	return timeline === 'local' || timeline === 'social' || timeline === 'rl-relay' || timeline === 'rl-relay-social' || timeline === 'vmimi-relay' || timeline === 'vmimi-relay-social';
}

export function hasWithLocalOnly(timeline: BasicTimelineType | undefined | null): boolean {
	return timeline === 'vmimi-relay' || timeline === 'vmimi-relay-social' || timeline === 'rl-relay' || timeline === 'rl-relay-social';
}
