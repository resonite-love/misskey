/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api, loadSite, savePrivateJson, sites } from './lab.mjs';

const [peerRepo, externalRepo] = process.argv.slice(2);
if (!peerRepo || !externalRepo) throw new Error('Usage: node scripts/gridspace/seed-lab.mjs <resonite-repository> <external-repository>');
const labs = [fileURLToPath(new URL('../../', import.meta.url)), peerRepo, externalRepo].map(loadSite);

for (const site of labs) {
	const state = existsSync(site.accountsPath) ? JSON.parse(readFileSync(site.accountsPath, 'utf8')) : { origin: site.origin, accounts: {} };
	assert.equal(state.origin, site.origin);
	for (const name of ['admin', 'author', 'reader', 'locked']) {
		const account = state.accounts[name] ?? { username: `lab_${name}`, password: randomBytes(24).toString('base64url') };
		state.accounts[name] = account;
		// Persist the password before creating an account so interrupted runs can recover.
		savePrivateJson(site.accountsPath, state);
		if (!account.token) {
			const existing = await api(site, 'users/show', { username: account.username }).catch(error => {
				if (error.code === 'NO_SUCH_USER') return null;
				throw error;
			});
			if (existing) {
				const signedIn = await api(site, 'signin-flow', { username: account.username, password: account.password });
				assert.equal(signedIn.finished, true, 'The fixture account requires an unexpected login challenge.');
				Object.assign(account, { id: signedIn.id, token: signedIn.i });
			} else {
				const created = await api(site, 'admin/accounts/create', {
					username: account.username,
					password: account.password,
					...(name === 'admin' ? { setupPassword: site.config.setupPassword } : {}),
				}, name === 'admin' ? undefined : state.accounts.admin.token);
				Object.assign(account, { id: created.id, token: created.token });
			}
			savePrivateJson(site.accountsPath, state);
		}
		assert.equal((await api(site, 'i', {}, account.token)).id, account.id);
		if (name === 'admin') {
			await api(site, 'admin/update-meta', {
				name: site.name,
				description: 'Disposable GridSpace integration test server. No production accounts or data.',
				disableRegistration: true,
				federation: 'specified',
				federationHosts: sites.filter(other => other.origin !== site.origin).map(other => new URL(other.origin).host),
			}, account.token);
		}
		if (name === 'locked') await api(site, 'i/update', { isLocked: true }, account.token);
		console.log(`${site.role}: @${account.username} ready`);
	}
	console.log(`${site.role}: private credentials saved to ${site.accountsPath}`);
}
