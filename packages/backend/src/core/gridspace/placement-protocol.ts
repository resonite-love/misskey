/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { channelActionSchema, channelOptionsSchema, channelResultSchema, type ChannelUpdate } from './channel-protocol.js';
import type { GridspacePeerConfig } from './peer-protocol.js';

export const placementCapability = 'channel-placement-v1';
export const channelRepliesCapability = 'channel-placement-replies-v1';
export const linkedChannelFollowsCapability = 'channel-placement-linked-follows-v1';
export const originPlacementCapability = 'channel-placement-origin-lookup-v1';
export const placementPath = '/gridspace/v1/placements/';
export type PlacementPurpose = 'read' | 'reply' | 'upload' | 'action';
export type PlacementPreview = {
	text?: string | null;
	cw?: string | null;
	pollChoices?: string[] | null;
	files?: { name: string; comment?: string | null; isSensitive: boolean }[];
};
export type PreparedRemotePlacement = { origin: string; channelId: string; name: string; color: string };
export type PlacementChannels = {
	channelId?: string; before?: string; list?: 'featured' | 'following' | 'favorite' | 'favorites' | 'owned' | 'search';
	query?: string; queryType?: 'nameOnly' | 'nameAndDescription'; limit?: number;
};
export const placementChannelOptions = {
	channelId: channelOptionsSchema.channelId, before: channelOptionsSchema.before, query: channelOptionsSchema.query,
	queryType: channelOptionsSchema.queryType, list: { type: 'string', enum: ['featured', 'following', 'favorite', 'favorites', 'owned', 'search'] }, limit: channelOptionsSchema.limit,
} as const;
export const placementChannelResult = {
	...channelResultSchema, properties: { ...channelResultSchema.properties, enabled: { type: 'boolean', nullable: false, optional: false },
		channels: { ...channelResultSchema.properties.channels, items: { ...channelResultSchema.properties.channels.items, properties: {
			...channelResultSchema.properties.channels.items.properties, allowRenoteToExternal: { type: 'boolean', nullable: false, optional: false },
		} } } },
} as const;
export type PlacementStatus = {
	canonicalUri: string; channelId: string; placementId: string | null; sourceRevision: number; targetRevision: number;
	state: 'active' | 'removed' | 'origin-deleted';
};
export type PlacementLookupKey = Pick<PlacementStatus, 'canonicalUri' | 'channelId' | 'placementId' | 'sourceRevision' | 'targetRevision'>;
export type PlacementLookupRow = { isSensitive?: boolean; isArchived?: boolean; allowRenoteToExternal?: boolean; placementId: string; ownerUri: string | null; name: string; color: string };
export type OriginPlacementRoot = { noteId: string; channels: (PlacementLookupRow & { channelId: string })[] };
export type PlacementProof = {
	actorUri: string; canonicalUri: string; channelOrigin: string; channelId: string; placementId: string;
	purpose: PlacementPurpose; sourceRevision: number; targetRevision: number; expiresAt: number; signature: string;
};

export function previewHash(preview: PlacementPreview): string {
	const normalized = [preview.text ?? '', preview.cw ?? '', preview.pollChoices ?? [], (preview.files ?? []).map(f => [f.name, f.comment ?? '', f.isSensitive])];
	return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function signPlacementProof(peer: GridspacePeerConfig, p: Omit<PlacementProof, 'signature'>): string {
	return createHmac('sha256', peer.secret).update(JSON.stringify(['placement-proof-v1', peer.communityId, p.actorUri,
		p.canonicalUri, p.channelOrigin, p.channelId, p.placementId, p.purpose, p.sourceRevision, p.targetRevision, p.expiresAt])).digest('base64url');
}

export function verifyPlacementProof(peer: GridspacePeerConfig, proof: PlacementProof, actorUri: string, canonicalUri: string, purpose: PlacementPurpose, now = Date.now()): boolean {
	return proof.actorUri === actorUri && proof.canonicalUri === canonicalUri && proof.purpose === purpose && proof.channelOrigin === peer.peerOrigin &&
		Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now && proof.expiresAt <= now + 60_000 &&
		typeof proof.signature === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(proof.signature) &&
		timingSafeEqual(Buffer.from(proof.signature), Buffer.from(signPlacementProof(peer, proof)));
}

const id = channelOptionsSchema.channelId;
const uri = { type: 'string', maxLength: 512, minLength: 1 } as const;
const revision = { type: 'integer', minimum: 0, maximum: 2147483647 } as const;
const text = { type: ['string', 'null'], maxLength: 100000 } as const;
const preview = { type: 'object', additionalProperties: false, properties: {
	text, cw: text, pollChoices: { type: ['array', 'null'], items: text },
	files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'isSensitive'],
		properties: { name: { type: 'string', maxLength: 2048 }, comment: text, isSensitive: { type: 'boolean' } } } },
} } as const;
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const common = { channelId: id, canonicalUri: uri, sourceRevision: revision } as const;
const prepare = { actorId: id, channelId: id, preview, hash, includeDefault: { type: 'boolean' } } as const;
const status = { ...common, placementId: { type: ['string', 'null'], format: 'uuid' }, targetRevision: revision,
	state: { type: 'string', enum: ['active', 'removed', 'origin-deleted'] } } as const;
const proof = { actorUri: uri, canonicalUri: uri, channelId: id, purpose: { type: 'string', enum: ['read', 'reply', 'upload', 'action'] } } as const;

function body(properties: object, required = Object.keys(properties)) {
	return { type: 'object', additionalProperties: false, properties, required };
}

export const placementSchemas = {
	channels: body({ actorId: id, ...placementChannelOptions }, ['actorId']),
	lookup: body({ viewerActorUri: uri, keys: { type: 'array', maxItems: 100, minItems: 1, items: body({
		...common, placementId: { type: 'string', format: 'uuid' }, targetRevision: revision,
	}) } }, ['keys']),
	'origin-lookup': body({ viewerActorUri: uri, noteIds: { type: 'array', items: id, minItems: 1, maxItems: 100, uniqueItems: true } }, ['noteIds']),
	'channel-update': body({ actorId: id, channelId: id, action: channelActionSchema }),
	prepare: body(prepare), sync: body(common),
	place: body({ ...prepare, ...common, sortAt: { type: 'string', format: 'date-time' } }),
	remove: body({ ...common, actorId: id, sortAt: { type: 'string', format: 'date-time' }, includeDefault: { type: 'boolean' } }),
	'delete-origin': body(common), status: body(status), 'request-status': body(common),
	proof: body(proof),
} as const;
export type PlacementInputs = {
	channels: PlacementChannels & { actorId: string };
	lookup: { viewerActorUri?: string; keys: PlacementLookupKey[] };
	'origin-lookup': { viewerActorUri?: string; noteIds: string[] };
	'channel-update': ChannelUpdate & { actorId: string };
	prepare: { actorId: string; channelId: string; preview: PlacementPreview; hash: string; includeDefault: boolean };
	place: PlacementInputs['prepare'] & { canonicalUri: string; sourceRevision: number; sortAt: string };
	remove: PlacementInputs['delete-origin'] & Pick<PlacementInputs['place'], 'actorId' | 'sortAt' | 'includeDefault'>;
	'delete-origin': Pick<PlacementStatus, 'channelId' | 'canonicalUri' | 'sourceRevision'>; 'request-status': PlacementInputs['delete-origin'];
	sync: PlacementInputs['delete-origin'];
	status: PlacementStatus;
	proof: Pick<PlacementProof, 'actorUri' | 'canonicalUri' | 'channelId' | 'purpose'>;
};
