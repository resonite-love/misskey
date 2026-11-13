/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const managedKinds = ['antenna', 'page', 'clip', 'gallery'] as const;
export type ManagedKind = typeof managedKinds[number];
export type ManagedInput = { kind: ManagedKind; action: 'list' | 'show' | 'update' | 'delete' | 'lists'; id?: string; data?: Record<string, unknown> };
export type ManagedPeerInput = ManagedInput & { linkId: string; generation: number; localUserId: string; peerUserId: string };
export const managedInputProperties = {
	kind: { type: 'string', enum: managedKinds },
	action: { type: 'string', enum: ['list', 'show', 'update', 'delete', 'lists'] },
	id: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	data: { type: 'object', additionalProperties: true },
} as const;
export const managedPeerSchema = {
	type: 'object', additionalProperties: false, required: ['kind', 'action', 'linkId', 'generation', 'localUserId', 'peerUserId'],
	properties: { ...managedInputProperties, linkId: { type: 'string', format: 'uuid' }, generation: { type: 'integer', minimum: 1 },
		localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, peerUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } },
} as const;
export const managedError = { message: 'The linked resource is unavailable.', code: 'GRIDSPACE_RESOURCE_UNAVAILABLE', id: '665e35d2-3ae9-47c6-8640-7d11778a5e50' } as const;
export const managedId = (kind: ManagedKind, id: string) => `gridspace:${kind}:${id}`;
