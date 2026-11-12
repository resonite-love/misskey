/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [peerRepo, externalRepo] = process.argv.slice(2);
if (!peerRepo || !externalRepo) {
	console.error('Usage: node scripts/gridspace/setup-lab.mjs <resonite-repository> <unmodified-external-repository>');
	process.exit(1);
}
const repos = [root, resolve(peerRepo), resolve(externalRepo)].map(path => realpathSync(path));
if (new Set(repos.map(path => path.toLowerCase())).size !== 3) throw new Error('Use three separate repository directories.');
for (const repo of repos) {
	if (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name !== 'misskey') throw new Error('Each directory must be a Misskey checkout.');
	for (const name of ['gridspace-lab.yml', 'gridspace-lab.env']) {
		if (existsSync(join(repo, '.config', name))) throw new Error(`Refusing to overwrite ${join(repo, '.config', name)}`);
	}
}

const password = randomBytes(32).toString('hex');
const key = randomBytes(32).toString('base64');
const origins = ['https://grid-space-misskey.kokopi.me', 'https://resonite-love-misskey.kokopi.me', 'https://gridspace-e-dev.kokopi.me'];
for (const [index, repo] of repos.entries()) {
	const config = {
		url: origins[index],
		port: 13000 + index,
		setupPassword: randomBytes(32).toString('hex'),
		db: { host: '127.0.0.1', port: 15432 + index * 10000, db: 'misskey', user: 'gridspace', pass: password },
		redis: { host: '127.0.0.1', port: 16379 + index * 10000 },
		id: 'aidx',
		clusterLimit: 1,
		fulltextSearch: { provider: 'sqlLike' },
		proxyRemoteFiles: true,
		trustProxy: ['127.0.0.1/32', '::1/128'],
		...(index === 2 ? {} : {
			gridspace: { enabled: true, communityId: 'gridspace-lab', peerUrl: origins[1 - index], keyId: 'lab-v1', secretEnv: 'GRIDSPACE_LAB_PEER_KEY' },
		}),
	};
	mkdirSync(join(repo, '.config'), { recursive: true });
	writeFileSync(join(repo, '.config/gridspace-lab.yml'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
	writeFileSync(join(repo, '.config/gridspace-lab.env'), `GRIDSPACE_LAB_DB_PASSWORD=${password}\n${index === 2 ? '' : `GRIDSPACE_LAB_PEER_KEY=${key}\n`}`, { flag: 'wx', mode: 0o600 });
	console.log(`${['G', 'R', 'E'][index]}: ${origins[index]} -> 127.0.0.1:${config.port} (${repo})`);
}
console.log('Created ignored test configuration files. Existing production configuration was not changed.');
