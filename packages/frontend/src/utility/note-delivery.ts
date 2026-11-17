/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';

export type NoteDelivery = 'public' | 'noRelay' | 'local';

export function getNoteDelivery(flags: { localOnly: boolean; noRelay: boolean }): NoteDelivery {
	if (flags.localOnly) return 'local';
	return flags.noRelay ? 'noRelay' : 'public';
}

export function getDefaultNoteDelivery(value: boolean | 'noRelay'): NoteDelivery {
	return value === 'noRelay' ? value : value ? 'local' : 'public';
}

export function getNoteDeliveryFlags(mode: NoteDelivery) {
	return { localOnly: mode === 'local', noRelay: mode === 'noRelay' };
}

export function getNoteDeliveryOptions() {
	return {
		public: {
			value: 'public',
			label: i18n.ts._visibility.deliveryPublic,
			description: i18n.ts._visibility.deliveryPublicDescription,
			icon: 'ti ti-rocket',
		},
		noRelay: {
			value: 'noRelay',
			label: i18n.ts._visibility.noRelay,
			description: i18n.ts._visibility.noRelayDescription,
			icon: 'ti ti-route-off',
		},
		local: {
			value: 'local',
			label: i18n.ts._visibility.disableFederation,
			description: i18n.ts._visibility.deliveryLocalDescription,
			icon: 'ti ti-rocket-off',
		},
	} as const;
}
