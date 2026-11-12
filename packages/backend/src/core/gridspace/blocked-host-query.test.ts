/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import { DataSource, EntitySchema } from 'typeorm';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig } from '@/config.js';
import { QueryService } from '@/core/QueryService.js';
import type { MiMeta } from '@/models/_.js';

const config = loadConfig();
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	entities: [new EntitySchema({ name: 'HostNote', tableName: 'host_notes', columns: {
		id: { type: String, primary: true },
		...Object.fromEntries(['userId', 'userHost', 'replyUserId', 'replyUserHost', 'renoteUserId', 'renoteUserHost'].map(name => [name, { type: String, nullable: true }])),
	} })],
});
beforeAll(async () => { await db.initialize(); });
afterAll(async () => { await db.destroy(); });

test('blocked-host query preserves local, remote, reply and renote filtering with one array parameter', async () => {
	const blockedHosts = ['bad.example', 'UPPER.example', ...Array.from({ length: 91 }, (_, i) => `blocked${i}.example`)];
	const service = new QueryService(mockDeep(), mockDeep(), mockDeep(), mockDeep(), mockDeep(), mockDeep(), mockDeep(), { blockedHosts } as MiMeta, mockDeep());
	const runner = db.createQueryRunner(); await runner.startTransaction();
	try {
		await runner.query('CREATE TEMP TABLE host_notes (id text, "userId" text, "userHost" text, "replyUserId" text, "replyUserHost" text, "renoteUserId" text, "renoteUserHost" text)');
		const hosts = [null, 'good.example', 'bad.example', 'sub.bad.example', 'upper.example', 'sub.UPPER.example', 'bad.example.evil', 'blocked90.example'];
		let id = 0;
		for (const author of hosts) for (const reply of hosts) for (const renote of hosts) {
			await runner.query('INSERT INTO host_notes VALUES ($1,$2,$3,$4,$5,$6,$7)', [String(id++), 'author', author, 'reply', reply, 'renote', renote]);
		}
		const query = db.createQueryBuilder().select('note.id', 'id').from('HostNote', 'note').setQueryRunner(runner);
		service.generateBlockedHostQueryForNote(query);
		const [sql, params] = query.getQueryAndParameters();
		expect(params).toHaveLength(1); expect(params[0]).toHaveLength(186);
		const actual = await runner.query(sql, params);
		const old = await runner.query(`SELECT id FROM host_notes WHERE ${['user', 'replyUser', 'renoteUser'].map(column => `("${column}Id" IS NULL OR "${column}Host" IS NULL OR "${column}Host" NOT ILIKE ALL($1::text[]))`).join(' AND ')}`, params);
		expect(actual.map((row: { id: string }) => row.id).sort()).toEqual(old.map((row: { id: string }) => row.id).sort());
		expect(actual.length).toBeGreaterThan(0); expect(actual.length).toBeLessThan(id);
	} finally { await runner.rollbackTransaction(); await runner.release(); }
});
