/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const sites = [
	{ role: 'G', origin: 'https://grid-space-misskey.kokopi.me', name: 'GridSpace (test)' },
	{ role: 'R', origin: 'https://resonite-love-misskey.kokopi.me', name: 'resonite.love (test)' },
	{ role: 'E', origin: 'https://gridspace-e-dev.kokopi.me', name: 'External Misskey (test)' },
];

export function loadSite(repository, index) {
	const repo = resolve(repository);
	const config = JSON.parse(readFileSync(resolve(repo, '.config/gridspace-lab.yml'), 'utf8'));
	const site = sites[index];
	if (config.url !== site.origin || config.port !== 13000 + index || config.db.host !== '127.0.0.1' || config.db.db !== 'misskey' || config.db.port !== 15432 + index * 10000) {
		throw new Error(`Refusing to run fixture operations outside the dedicated ${site.role} lab configuration.`);
	}
	return { ...site, repo, config, accountsPath: resolve(repo, '.config/gridspace-lab-accounts.json') };
}

export function savePrivateJson(path, value) {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

export async function api(site, endpoint, params = {}, token) {
	const response = await fetch(`${site.origin}/api/${endpoint}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...params, ...(token ? { i: token } : {}) }),
		redirect: 'error',
		signal: AbortSignal.timeout(15000),
	});
	const body = response.status === 204 ? undefined : await response.json();
	if (!response.ok) {
		// Never print response bodies: an upstream error could contain credentials.
		const code = /^[A-Z_]+$/.test(body?.error?.code) ? body.error.code : 'HTTP_ERROR';
		const error = new Error(`${site.role} ${endpoint}: HTTP ${response.status} (${code})`);
		error.code = code;
		throw error;
	}
	return body;
}

export async function eventually(label, predicate, timeout = 20000) {
	const deadline = Date.now() + timeout;
	do {
		if (await predicate()) return;
		await new Promise(resolveWait => setTimeout(resolveWait, 500));
	} while (Date.now() < deadline);
	throw new Error(`Timed out: ${label}`);
}
