/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config.js';
import type { DataSource } from 'typeorm';
import type { RoleService } from '@/core/RoleService.js';
import type { GridspaceSearchService } from '../GridspaceSearchService.js';
import type { IdService } from '@/core/IdService.js';
import { TimelinePublicListSource } from './TimelinePublicListSource.js';

function fixture() {
	const query = { andWhere: vi.fn().mockReturnThis() };
	const findOneBy = vi.fn().mockResolvedValue(null);
	const policies = vi.fn().mockResolvedValue({ canSearchNotes: true });
	const noteQuery = vi.fn().mockReturnValue(query);
	const source = new TimelinePublicListSource({ getRepository: () => ({ findOneBy }) } as unknown as DataSource,
		{ url: 'https://source.test', gridspace: { enabled: true, peerUrl: 'https://reader.test' } } as Config,
		{ getUserPolicies: policies } as unknown as RoleService, { noteQuery } as unknown as GridspaceSearchService,
		{ parse: () => ({ date: new Date(1000) }) } as unknown as IdService);
	return { source, query, findOneBy, policies, noteQuery };
}

describe('public peer list scope', () => {
	test('authenticated but uncached reader gets only source-safe public candidates', async () => {
		const { source, findOneBy, noteQuery, query } = fixture();
		await source.buildQuery({ kind: 'profile', viewerId: 'viewer', targetUris: ['https://source.test/users/author'], withRenotes: false });
		expect(findOneBy).toHaveBeenCalledWith({ uri: 'https://reader.test/users/viewer' });
		expect(noteQuery).toHaveBeenCalledWith(null, { query: '', rangeStartAt: undefined, rangeEndAt: undefined }, true, true, undefined, true);
		expect(query.andWhere).toHaveBeenCalledWith("(:publicListOrigin || '/users/' || note.userId) IN (:...publicListTargets)", { publicListOrigin: 'https://source.test', publicListTargets: ['https://source.test/users/author'] });
	});
	test('a search policy refusal cannot produce a public-import candidate', async () => {
		const { source, policies, noteQuery } = fixture(); policies.mockResolvedValue({ canSearchNotes: false });
		await expect(source.buildQuery({ kind: 'search', query: 'query', viewerId: 'viewer' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(noteQuery).not.toHaveBeenCalled();
	});
	test('a suspended visitor and unscoped profile are rejected', async () => {
		const { source, findOneBy, noteQuery } = fixture(); findOneBy.mockResolvedValue({ id: 'cached', isSuspended: true });
		await expect(source.buildQuery({ kind: 'search', query: 'query', viewerId: 'viewer' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		await expect(source.buildQuery({ kind: 'profile', viewerId: 'viewer' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(noteQuery).not.toHaveBeenCalled();
	});
	test('anonymous reads retain visitor policy checks instead of claiming authenticated access', async () => {
		const { source, noteQuery } = fixture();
		await source.buildQuery({ kind: 'search', query: 'query' });
		expect(noteQuery).toHaveBeenCalledWith(null, expect.objectContaining({ query: 'query' }), true, false, undefined, false);
	});
});
