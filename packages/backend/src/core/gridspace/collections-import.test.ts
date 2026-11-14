/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserList } from '@/models/UserList.js';
import { MiUserListMembership } from '@/models/UserListMembership.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { MiAntenna } from '@/models/Antenna.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { IdService } from '@/core/IdService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { UserListService } from '@/core/UserListService.js';
import type { RegistryApiService } from '@/core/RegistryApiService.js';
import type { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import ListImport from '@/server/api/endpoints/gridspace/list-import.js';
import { StatusError } from '@/misc/status-error.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { GridspaceLinkError, type GridspaceLinkService } from './GridspaceLinkService.js';
import { parseLinkedLists, parseLinkedAntennas, migrateAntennaUsers, type LinkedList, type LinkedAntenna } from './collections-protocol.js';

const antenna = (): LinkedAntenna => ({ id: 'a1', name: 'Human', src: 'users', userListId: null, users: ['alice', '@bob@g.example', 'cat@other.example'], keywords: [['a', 'b'], ['c']], excludeKeywords: [['hide']], expression: null, caseSensitive: true, localOnly: false, excludeBots: true, withReplies: true, withFile: false, excludeNotesInSensitiveChannel: true });

function fixture(members = 8) {
	const user = { id: 'me' } as MiLocalUser;
	const links = mockDeep<GridspaceLinkService>();
	const binding = { linkId: 'link', generation: 1, credentialHash: 'credential', peerUserId: 'old', peerOrigin: 'https://r.example' };
	const source: LinkedList[] = [{ id: 'source', name: 'Friends', isPublic: false, members: Array.from({ length: members }, (_, i) => ({ uri: `https://r.example/users/u${i}`, withReplies: i % 2 === 0 })) }];
	links.lists.mockImplementation(async () => ({ ...binding, lists: structuredClone(source) }));
	const sourceAntennas: LinkedAntenna[] = [];
	links.antennas.mockImplementation(async () => ({ ...binding, antennas: structuredClone(sourceAntennas) }));
	links.checkSettingsAuthorization.mockImplementation(async () => ({ ...binding }));
	const guard = mockDeep<GridspaceFollowGuardService>(); guard.runProfile.mockImplementation(async (_id, action) => action());
	const registry = mockDeep<RegistryApiService>(); let saved: any;
	let failSaveAfter = -1;
	registry.getItem.mockImplementation(async () => saved ? { id: 'receipt', value: structuredClone(saved) } as never : null);
	registry.set.mockImplementation(async (_id, _domain, _scope, _key, value: any) => {
		if (failSaveAfter >= 0 && value.lists[0].created && value.lists[0].members.filter((s: string) => s === 'done').length >= failSaveAfter) { failSaveAfter = -1; throw new Error('Lost receipt acknowledgement'); }
		saved = structuredClone(value);
	});
	const people = mockDeep<ApPersonService>(); people.resolvePerson.mockImplementation(async uri => ({ id: String(uri).split('/').at(-1) }) as never);
	const db = mockDeep<DataSource>(); const manager = mockDeep<EntityManager>();
	const targets = new Map<string, any>(); const memberships = new Set<string>();
	const antennas = new Map<string, any>();
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiUserList ? {
		findOneBy: async ({ id }: { id: string }) => targets.get(id) ?? null,
		findOneByOrFail: async ({ id }: { id: string }) => { if (!targets.has(id)) throw new Error('Missing'); return targets.get(id); }, countBy: async () => targets.size, existsBy: async ({ id }: { id: string }) => targets.has(id),
	} : entity === MiAntenna ? { countBy: async () => antennas.size } : entity === MiUser ? { findOneBy: async () => null } : entity === MiUserListMembership ? { existsBy: async ({ userId }: { userId: string }) => memberships.has(userId) } : { existsBy: async () => false }) as DataSource['getRepository']);
	manager.create.mockImplementation(((_entity: unknown, value: any) => value) as never);
	manager.insert.mockImplementation((async (entity: unknown, value: any) => { if (entity === MiUserList) targets.set(value.id, structuredClone(value)); if (entity === MiAntenna) antennas.set(value.id, structuredClone(value)); return {}; }) as never);
	manager.update.mockImplementation((async (entity: unknown, _id: unknown, value: any) => { if (entity === MiRegistryItem) saved = structuredClone(value.value); return { affected: 1 }; }) as never);
	db.transaction.mockImplementation((async (action: (m: EntityManager) => Promise<unknown>) => action(manager)) as never);
	const ids = mockDeep<IdService>(); let next = 0; ids.gen.mockImplementation(() => `new${next++}`);
	const roles = mockDeep<RoleService>(); roles.getUserPolicies.mockResolvedValue({ userListLimit: 10, antennaLimit: 10 } as never);
	const lists = mockDeep<UserListService>(); lists.addMember.mockImplementation(async (target, _list, _me, options) => { memberships.add(target.id); await options?.receipt?.(manager); });
	const events = mockDeep<GlobalEventService>();
	const endpoint = new ListImport(links, guard, registry, people, ids, roles, lists, db, { url: 'https://g.example', gridspace: { channelRole: 'client' } } as Config, events);
	return { links, binding, source, sourceAntennas, antennas, roles, events, people, lists, targets, memberships, registry, legacyReceipt: () => { delete saved.antennas; }, failSave: (after: number) => { failSaveAfter = after; }, call: (action = 'start') => endpoint.exec({ action }, user, null) };
}

describe('list import receipts', () => {
	test('copies at most five operations per step, preserves replies, resumes and does not duplicate names', async () => {
		const f = fixture();
		expect(await f.call()).toMatchObject({ total: 9, done: 5, pending: 4 });
		expect(await f.call()).toMatchObject({ complete: true, done: 9 });
		expect(f.targets.size).toBe(1); expect(f.memberships.size).toBe(8);
		expect(f.lists.addMember.mock.calls[0][3]?.withReplies).toBe(true);
		f.targets.get('new0').name = 'Edited'; f.memberships.delete('u0');
		await f.call('retry'); expect(f.targets.get('new0').name).toBe('Edited'); expect(f.memberships.has('u0')).toBe(false);
	});
	test('a committed list remains recorded after acknowledgement loss and is not recreated after deletion', async () => {
		const f = fixture(0); f.failSave(0);
		await expect(f.call()).rejects.toThrow('Lost receipt acknowledgement');
		expect(f.targets.size).toBe(1); f.targets.clear();
		expect(await f.call()).toMatchObject({ complete: true }); expect(f.targets.size).toBe(0);
	});
	test('a committed membership remains recorded after acknowledgement loss and is not restored after removal', async () => {
		const f = fixture(1); f.failSave(1);
		await expect(f.call()).rejects.toThrow('Lost receipt acknowledgement');
		f.memberships.clear();
		expect(await f.call()).toMatchObject({ complete: true }); expect(f.memberships.size).toBe(0);
	});
	test('only failed members are retried', async () => {
		const f = fixture(2); f.people.resolvePerson.mockRejectedValueOnce(new Error('Offline'));
		expect(await f.call()).toMatchObject({ done: 2, failed: 1, pending: 0 });
		expect(await f.call('retry')).toMatchObject({ complete: true }); expect(f.lists.addMember).toHaveBeenCalledTimes(2);
	});
	test('stops on revoked authorization after actor resolution', async () => {
		const f = fixture(1); f.people.resolvePerson.mockImplementation(async () => { f.links.checkSettingsAuthorization.mockRejectedValue(new GridspaceLinkError('LINK_REVOKED')); return { id: 'u0' } as never; });
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_LISTS_UNAVAILABLE' }); expect(f.lists.addMember).not.toHaveBeenCalled();
	});
	test('rejects credential replacement while stepping; a new start may resume the same source owner', async () => {
		const f = fixture(); await f.call(); f.binding.credentialHash = 'new';
		await expect(f.call('step')).rejects.toMatchObject({ code: 'GRIDSPACE_LISTS_UNAVAILABLE' });
		expect(await f.call()).toMatchObject({ complete: true }); expect(f.targets.size).toBe(1);
	});
	test('rejects duplicate source IDs and unsafe actor URLs', () => {
		const list = { id: 'a', name: 'List', isPublic: false, members: [] };
		expect(() => parseLinkedLists([list, list])).toThrow();
		for (const uri of ['file:///etc/passwd', 'https://u:p@example.com/users/u']) expect(() => parseLinkedLists([{ ...list, members: [{ uri, withReplies: false }] }])).toThrow();
	});
	test('copies antenna conditions and remaps a source list and local account names once', async () => {
		const f = fixture(0);
		f.sourceAntennas.push(antenna(), { ...antenna(), id: 'a2', src: 'list', userListId: 'source' });
		expect(await f.call()).toMatchObject({ complete: true, done: 3 });
		const copy = [...f.antennas.values()][0];
		expect(copy).toMatchObject({ ...antenna(), id: 'new1', userId: 'me', users: ['alice@r.example', 'bob', 'cat@other.example'], isActive: true });
		expect([...f.antennas.values()][1].userListId).toBe('new0');
		expect(f.events.publishInternalEvent).toHaveBeenCalledTimes(2);
		f.antennas.clear(); await f.call('retry');
		expect(f.antennas.size).toBe(0);
	});
	test('does not create a list antenna with incomplete members and can retry after recovery', async () => {
		const f = fixture(1); f.sourceAntennas.push({ ...antenna(), src: 'list', userListId: 'source' });
		f.people.resolvePerson.mockRejectedValueOnce(new Error('Offline'));
		expect(await f.call()).toMatchObject({ failed: 2 }); expect(f.antennas.size).toBe(0);
		expect(await f.call('retry')).toMatchObject({ complete: true }); expect(f.antennas.size).toBe(1);
	});
	test('enforces antenna limits without overwriting existing data', async () => {
		const f = fixture(0); f.sourceAntennas.push(antenna()); f.roles.getUserPolicies.mockResolvedValue({ userListLimit: 10, antennaLimit: 0 } as never);
		expect(await f.call()).toMatchObject({ failed: 1 }); expect(f.antennas.size).toBe(0);
	});
	test('upgrades a completed older receipt without recreating lists', async () => {
		const f = fixture(0); await f.call(); f.legacyReceipt(); f.sourceAntennas.push(antenna());
		expect(await f.call('status')).toMatchObject({ complete: false });
		expect(await f.call()).toMatchObject({ complete: true, done: 2 });
		expect(f.targets.size).toBe(1); expect(f.antennas.size).toBe(1);
	});
	test('copies native all-post antennas with an unused blank users field', async () => {
		const f = fixture(0);
		f.sourceAntennas.push({ ...antenna(), src: 'all', users: [''] });
		expect(await f.call()).toMatchObject({ complete: true, failed: 0 });
		expect([...f.antennas.values()][0]).toMatchObject({ src: 'all', users: [], keywords: antenna().keywords, excludeKeywords: antenna().excludeKeywords });
		expect(await f.call('retry')).toMatchObject({ complete: true }); expect(f.antennas.size).toBe(1);
	});
	test('validates antenna payloads and account origin mapping', () => {
		expect(parseLinkedAntennas([antenna()])).toEqual([antenna()]);
		expect(() => parseLinkedAntennas([antenna(), antenna()])).toThrow();
		expect(() => parseLinkedAntennas([{ ...antenna(), localOnly: 'false' }])).toThrow();
		expect(() => parseLinkedAntennas([{ ...antenna(), keywords: ['bad'] }])).toThrow();
		expect(migrateAntennaUsers(['local', '@other@outside.example'], 'https://r.example', 'https://g.example')).toEqual(['local@r.example', 'other@outside.example']);
		expect(migrateAntennaUsers(['', ' \t', 'local', ''], 'https://r.example', 'https://g.example')).toEqual(['local@r.example']);
	});
});

describe('gone list members', () => {
 test('skips HTTP 410 during actor resolution and finishes the remaining members and dependent antenna', async () => {
  const f = fixture(2); f.sourceAntennas.push({ ...antenna(), src: 'list', userListId: 'source' });
  f.people.resolvePerson.mockRejectedValueOnce(new StatusError('410 Gone', 410));
  expect(await f.call()).toMatchObject({ complete: true, total: 4, done: 3, skipped: 1, failed: 0, pending: 0 });
  expect(f.memberships.has('u0')).toBe(false); expect(f.memberships.has('u1')).toBe(true);
  expect(f.antennas.size).toBe(1);
  const calls = f.people.resolvePerson.mock.calls.length;
  expect(await f.call('status')).toMatchObject({ complete: true, skipped: 1 });
  expect(await f.call('retry')).toMatchObject({ complete: true, skipped: 1 });
  expect(f.people.resolvePerson).toHaveBeenCalledTimes(calls); expect(f.targets.size).toBe(1);
 });
 test.each([404, 403, 429, 500, 503])('keeps HTTP %i failures retryable', async status => {
  const f = fixture(2); f.people.resolvePerson.mockRejectedValueOnce(new StatusError('Unavailable', status));
  expect(await f.call()).toMatchObject({ complete: false, done: 2, skipped: 0, failed: 1 });
  expect(await f.call('retry')).toMatchObject({ complete: true, done: 3, skipped: 0, failed: 0 });
  expect(f.targets.size).toBe(1); expect(f.memberships.size).toBe(2);
 });
 test('does not interpret an arbitrary error message as a Gone response', async () => {
  const f = fixture(1); f.people.resolvePerson.mockRejectedValueOnce(new Error('410 Gone'));
  expect(await f.call()).toMatchObject({ skipped: 0, failed: 1, complete: false });
 });
 test('does not skip a 410 from adding an already resolved member', async () => {
  const f = fixture(1); f.lists.addMember.mockRejectedValueOnce(new StatusError('410 Gone', 410));
  expect(await f.call()).toMatchObject({ skipped: 0, failed: 1, complete: false });
 });
 test('retries an older failed receipt and then preserves the skipped result', async () => {
  const f = fixture(1); f.people.resolvePerson.mockRejectedValueOnce(new Error('Offline'));
  expect(await f.call()).toMatchObject({ failed: 1 });
  f.people.resolvePerson.mockRejectedValueOnce(new StatusError('410 Gone', 410));
  expect(await f.call('retry')).toMatchObject({ complete: true, done: 1, skipped: 1, failed: 0 });
  expect(f.memberships.size).toBe(0); expect(f.targets.size).toBe(1);
 });
 test('rechecks authorization before saving a skipped member', async () => {
  const f = fixture(1); f.people.resolvePerson.mockImplementation(async () => {
   f.links.checkSettingsAuthorization.mockRejectedValue(new GridspaceLinkError('LINK_REVOKED'));
   throw new StatusError('410 Gone', 410);
  });
  await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_LISTS_UNAVAILABLE' });
  expect(f.registry.set.mock.calls.at(-1)?.[4]).toMatchObject({ lists: [{ members: ['pending'] }] });
 });
});

test('preserves a committed skip when only the save acknowledgement is lost', async () => {
 const f = fixture(1); f.people.resolvePerson.mockRejectedValueOnce(new StatusError('410 Gone', 410));
 const save = f.registry.set.getMockImplementation()!;
 let lost = false;
 f.registry.set.mockImplementation(async (...args) => {
  const result = await save(...args);
  if (!lost && (args[4] as any).lists[0].members[0] === 'skipped') { lost = true; throw new Error('Ack lost'); }
  return result;
 });
 expect(await f.call()).toMatchObject({ complete: true, done: 1, skipped: 1, failed: 0 });
 expect(await f.call('retry')).toMatchObject({ complete: true, skipped: 1 });
 expect(f.people.resolvePerson).toHaveBeenCalledTimes(1); expect(f.memberships.size).toBe(0);
});
