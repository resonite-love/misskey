/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onScopeDispose, shallowRef } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';

const aliases = shallowRef<Record<string, string>>({});
let consumers = 0;
let timer: number | undefined;
let pending: Promise<void> | undefined;
let refreshedAt = 0;

function refresh() {
	if (pending || window.document.hidden || Date.now() - refreshedAt < 30_000) return;
	pending = (async () => {
		try {
			const result = await misskeyApi('gridspace/emoji-aliases', {});
			if (JSON.stringify(result.aliases) !== JSON.stringify(aliases.value)) aliases.value = result.aliases;
		} catch { aliases.value = {}; } finally { refreshedAt = Date.now(); pending = undefined; }
	})();
}

export function useSyncedReactionAliases() {
	if (consumers++ === 0) {
		timer = window.setInterval(refresh, 30_000);
		window.document.addEventListener('visibilitychange', refresh);
	}
	refresh();
	onScopeDispose(() => {
		if (--consumers === 0) {
			window.clearInterval(timer);
			window.document.removeEventListener('visibilitychange', refresh);
		}
	});
	return aliases;
}
