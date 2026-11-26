/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type ResonitePackageInfo = {
	schemaVersion: 1;
	name: string;
	description?: string;
	recordCount: number;
	assetCount: number;
	assetBytes: number;
	unpackedBytes: number;
	variantCount: number;
	slotCount?: number;
	componentCount?: number;
	thumbnailDataUrl?: string;
};

export function isResonitePackageFile(file: { name: string }): boolean {
	return /\.resonitepackage$/i.test(file.name);
}

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Attachment properties may come from another server. Keep only bounded display data. */
export function readResonitePackageInfo(value: unknown): ResonitePackageInfo | null {
	if (!value || typeof value !== 'object') return null;
	const data = value as Record<string, unknown>;
	if (data.schemaVersion !== 1 || typeof data.name !== 'string' || data.name.length > 256) return null;
	if (!count(data.recordCount) || !count(data.assetCount) || !count(data.assetBytes) || !count(data.unpackedBytes) || !count(data.variantCount)) return null;
	const info: ResonitePackageInfo = {
		schemaVersion: 1,
		name: data.name,
		recordCount: data.recordCount,
		assetCount: data.assetCount,
		assetBytes: data.assetBytes,
		unpackedBytes: data.unpackedBytes,
		variantCount: data.variantCount,
	};
	if (typeof data.description === 'string' && data.description.length <= 2048) info.description = data.description;
	if (count(data.slotCount)) info.slotCount = data.slotCount;
	if (count(data.componentCount)) info.componentCount = data.componentCount;
	if (typeof data.thumbnailDataUrl === 'string' && data.thumbnailDataUrl.length <= 70 * 1024 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.thumbnailDataUrl)) {
		info.thumbnailDataUrl = data.thumbnailDataUrl;
	}
	return info;
}

export function packageInfoFromProperties(properties: unknown): ResonitePackageInfo | null {
	return properties && typeof properties === 'object'
		? readResonitePackageInfo((properties as Record<string, unknown>).resonitePackage)
		: null;
}

export function packageDownloadUrl(value: string, authorizedEphemeral = false): string | undefined {
	if (!value.trim()) return undefined;
	try {
		const url = new URL(value, 'https://example.invalid/');
		if (authorizedEphemeral && url.protocol === 'blob:') return value;
		return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : undefined;
	} catch {
		return undefined;
	}
}
