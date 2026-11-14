/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { host } from '@@/js/config.js';
import { $i } from '@/i.js';
import { prefer } from '@/preferences.js';
import { miLocalStorage } from '@/local-storage.js';
import { misskeyApi } from '@/utility/misskey-api.js';

type State = { managed: boolean; enabled: boolean };
type SyncOptions = {
	load: () => Promise<State>;
	save: (enabled: boolean) => Promise<State>;
	getPending: () => boolean | null;
	setPending: (enabled: boolean | null) => void;
	apply: (enabled: boolean) => void;
	listen: (callback: (enabled: boolean) => void) => void;
};

/** Pending explicit choices survive reloads and take priority over an older server value. */
export function createAutoTranslationPreferenceSync(options: SyncOptions) {
	let flushing = false;
	let managed: boolean | undefined;
	let starting: Promise<void> | undefined;
	let applying = false;
	options.listen(value => {
		if (applying || managed === false) return;
		options.setPending(value);
		void retry().catch(() => {});
	});

	async function flush() {
		if (managed !== true || flushing) return;
		flushing = true;
		try {
			while (true) {
				const value = options.getPending();
				if (value === null) break;
				await options.save(value);
				if (options.getPending() === value) options.setPending(null);
			}
		} catch {
			// Keep the explicit choice locally; retry on reconnect, visibility change, or next boot.
		} finally {
			flushing = false;
		}
	}

	async function start(): Promise<void> {
		if (managed !== undefined) return flush();
		return starting ??= (async () => {
			const state = await options.load();
			managed = state.managed;
			if (!managed) return;
			applying = true;
			try { options.apply(options.getPending() ?? state.enabled); } finally { applying = false; }
			await flush();
		})().finally(() => { starting = undefined; });
	}

	async function retry() { if (managed === undefined) await start(); else await flush(); }

	return { start, flush: retry };
}

let initialization: Promise<void> | undefined;
export function initializeAutoTranslationPreferences(): Promise<void> {
	const account = $i;
	if (!account) return Promise.resolve();
	return initialization ??= (async () => {
		const key = `autoTranslation.pending:${host}:${account.id}` as const;
		const sync = createAutoTranslationPreferenceSync({
			load: () => misskeyApi('auto-translation/preferences', {}, undefined, AbortSignal.timeout(10000)),
			save: enabled => misskeyApi('auto-translation/preferences', { enabled }, undefined, AbortSignal.timeout(10000)),
			getPending: () => {
				const value = miLocalStorage.getItem(key);
				return value === 'true' ? true : value === 'false' ? false : null;
			},
			setPending: value => { if (value === null) miLocalStorage.removeItem(key); else miLocalStorage.setItem(key, String(value)); },
			apply: value => {
				// This setting is synchronized by the account endpoint, not the optional old cloud profile.
				prefer.disableSync('autoTranslation.enabled');
				prefer.commit('autoTranslation.enabled', value);
			},
			listen: callback => { prefer.on('committed', event => { if (event.key === 'autoTranslation.enabled') callback(event.value as boolean); }); },
		});
		const retry = () => { void sync.flush().catch(() => {}); };
		window.addEventListener('online', retry);
		window.document.addEventListener('visibilitychange', () => { if (!window.document.hidden) retry(); });
		await sync.start();
	})().catch(error => {
		console.warn('Could not initialize account auto-translation preference:', error);
	});
}
