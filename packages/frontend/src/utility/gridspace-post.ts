/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import * as os from '@/os.js';

export async function gridspacePost(options: { channelId?: string; channel?: { name: string; color: string }; reply?: entities.GridspacePrivateNotesResponse['notes'][number]; renote?: entities.GridspacePrivateNotesResponse['notes'][number] }, onSent?: () => void) {
	const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkGridspacePostFormDialog.vue').then(module => module.default), options, {
		closed: () => dispose(),
		sent: () => onSent?.(),
	});
}
