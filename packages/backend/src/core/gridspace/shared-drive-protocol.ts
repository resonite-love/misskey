/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type SharedDriveRef = { origin: string; id: string };
export type SharedDriveWire = SharedDriveRef & {
	kind: 'file' | 'folder'; revision: number; deleted: boolean; createdAt: string;
	name: string; parent: SharedDriveRef | null;
	file?: { url: string; thumbnailUrl: string | null; webpublicUrl: string | null; webpublicType: string | null;
		type: string; md5: string; size: number; comment: string | null; blurhash: string | null;
		properties: { width?: number; height?: number; orientation?: number; avgColor?: string }; isSensitive: boolean };
};
export type SharedDriveValues = { name?: string; comment?: string | null; isSensitive?: boolean; parent?: SharedDriveRef | null };
export type SharedDriveRequest = {
	linkId: string; generation: number; localUserId: string; peerUserId: string;
	action: 'put' | 'get' | 'resolve' | 'mutate' | 'release'; kind?: 'file' | 'folder'; id?: string;
	wire?: SharedDriveWire; ancestors?: SharedDriveWire[]; values?: SharedDriveValues; deleted?: boolean;
};
export const sharedDriveRequestSchema = {
	type: 'object', additionalProperties: false, required: ['linkId', 'generation', 'localUserId', 'peerUserId', 'action'],
	properties: {
		linkId: { type: 'string', format: 'uuid' }, generation: { type: 'integer', minimum: 1 },
		localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, peerUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
		action: { type: 'string', enum: ['put', 'get', 'resolve', 'mutate', 'release'] }, kind: { type: 'string', enum: ['file', 'folder'] },
		id: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, wire: { type: 'object' },
		ancestors: { type: 'array', maxItems: 64, items: { type: 'object' } }, values: { type: 'object' }, deleted: { type: 'boolean' },
	},
} as const;

export const sharedDriveUnavailable = {
	message: 'The shared Drive is unavailable. Retry after the paired server recovers.', code: 'GRIDSPACE_SHARED_DRIVE_UNAVAILABLE', id: '1198627c-609c-4e2c-8e6d-82b334caf830',
} as const;

export function validateSharedDriveWire(wire: SharedDriveWire, origins: string[]): void {
	const ref = (value: SharedDriveRef) => value && origins.includes(value.origin) && typeof value.id === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(value.id);
	if (!wire || !ref(wire) || !['file', 'folder'].includes(wire.kind) || !Number.isSafeInteger(wire.revision) || wire.revision < 0 ||
		typeof wire.deleted !== 'boolean' || typeof wire.name !== 'string' || wire.name.length > 200 || !Number.isFinite(Date.parse(wire.createdAt)) || wire.parent !== null && !ref(wire.parent)) throw new Error('Invalid shared Drive entry');
	if (wire.deleted || wire.kind === 'folder') return;
	const file = wire.file;
	if (!file || typeof file.url !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.type !== 'string' || !file.type || file.type.length > 128 ||
		!/^[a-f0-9]{32}$/i.test(file.md5) || typeof file.isSensitive !== 'boolean' || file.comment !== null && (typeof file.comment !== 'string' || file.comment.length > 512) ||
		file.blurhash !== null && (typeof file.blurhash !== 'string' || file.blurhash.length > 128) || !file.properties || typeof file.properties !== 'object') throw new Error('Invalid shared Drive file');
	for (const value of [file.url, file.thumbnailUrl, file.webpublicUrl]) {
		if (value === null) continue;
		if (typeof value !== 'string' || value.length > 1024) throw new Error('Invalid shared Drive URL');
		const url = new URL(value);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid shared Drive URL');
	}
	for (const key of ['width', 'height', 'orientation'] as const) {
		const value = file.properties[key];
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e7)) throw new Error('Invalid image dimensions');
	}
}

export function validateSharedDriveValues(value: SharedDriveValues, origins: string[]): void {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) ||
		value.comment !== undefined && value.comment !== null && (typeof value.comment !== 'string' || value.comment.length > 512) ||
		value.isSensitive !== undefined && typeof value.isSensitive !== 'boolean') throw new Error('Invalid shared Drive changes');
	if (value.parent !== undefined && value.parent !== null && (!origins.includes(value.parent.origin) || !/^[a-zA-Z0-9]{1,32}$/.test(value.parent.id))) throw new Error('Invalid shared Drive folder');
}
