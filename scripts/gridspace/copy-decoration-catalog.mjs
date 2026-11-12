/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Administrative one-time catalog copy, independent of user account links.
// Set source/target origins and admin tokens in the environment, never in this file.
const source = process.env.GRIDSPACE_SOURCE_ORIGIN;
const target = process.env.GRIDSPACE_DESTINATION_ORIGIN;
const sourceToken = process.env.GRIDSPACE_SOURCE_TOKEN;
const targetToken = process.env.GRIDSPACE_DESTINATION_TOKEN;
if (!source || !target || !sourceToken || !targetToken || source === target) throw new Error('Distinct origins and administrator credentials are required');
for (const origin of [source, target]) if (new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') throw new Error('Use exact HTTPS origins');
async function call(origin, token, endpoint, params = {}) {
	const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, i: token }), redirect: 'error', signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
	return response.status === 204 ? null : response.json();
}
const sourceRows = await call(source, sourceToken, 'admin/avatar-decorations/list', { limit: 100 });
const destinationRows = await call(target, targetToken, 'admin/avatar-decorations/list', { limit: 100 });
if (sourceRows.some(row => row.roleIdsThatCanBeUsedThisDecoration.length)) throw new Error('Role-restricted definitions require an explicit role mapping; no catalog changes made');
let created = 0;
for (const row of sourceRows) {
	const existing = destinationRows.filter(d => d.name === row.name && d.url === row.url);
	if (existing.length > 1) throw new Error('Ambiguous destination catalog');
	if (existing.length) continue;
	const value = await call(target, targetToken, 'admin/avatar-decorations/create', { name: row.name, description: row.description, url: row.url, category: row.category ?? null, roleIdsThatCanBeUsedThisDecoration: [] });
	destinationRows.push(value); created++;
}
const verified = await call(target, targetToken, 'admin/avatar-decorations/list', { limit: 100 });
if (!sourceRows.every(row => verified.some(d => d.name === row.name && d.url === row.url))) throw new Error('Catalog verification failed');
console.log(JSON.stringify({ definitions: sourceRows.length, created, existing: sourceRows.length - created, verified: true }));
