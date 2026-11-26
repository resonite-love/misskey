/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';
import sharp from 'sharp';
import { ZipFile } from './zip.js';
import type { FileEntry } from '@zip.js/zip.js';

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

const MiB = 1024 * 1024;
const decompress = promisify(brotliDecompress);

function displayText(value: string, limit: number): string {
	return value.replaceAll('\0', '').slice(0, limit).toWellFormed();
}

async function readEntry(entry: FileEntry, limit: number): Promise<Buffer> {
	if (entry.uncompressedSize > limit || entry.compressedSize > limit + 1024) throw new Error('Entry exceeds size limit');
	const bytes = Buffer.alloc(entry.uncompressedSize);
	let offset = 0;
	await entry.getData(new WritableStream<Uint8Array>({
		write(chunk) {
			if (chunk.length > bytes.length - offset) throw new Error('Invalid ZIP entry size');
			bytes.set(chunk, offset);
			offset += chunk.length;
		},
	}));
	if (offset !== bytes.length) throw new Error('Incomplete ZIP entry');
	return bytes;
}

// Read the BSON elements of one document. Embedded values outside the slot
// hierarchy can be skipped by length without allocating objects or arrays.
function countObjectTree(bytes: Buffer): { slotCount: number; componentCount: number } {
	let remainingElements = 250000;
	let slotCount = 0;
	let componentCount = 0;

	function elements(start: number, end: number, visit: (key: string, type: number, value: number, next: number) => void) {
		if (end - start < 5 || bytes.readInt32LE(start) !== end - start || bytes[end - 1] !== 0) throw new Error('Invalid BSON document');
		let cursor = start + 4;
		while (cursor < end - 1) {
			if (--remainingElements < 0) throw new Error('BSON element limit exceeded');
			const type = bytes[cursor++];
			const keyEnd = bytes.indexOf(0, cursor);
			if (keyEnd < cursor || keyEnd >= end - 1 || keyEnd - cursor > 1024) throw new Error('Invalid BSON key');
			const key = bytes.toString('utf8', cursor, keyEnd);
			const value = keyEnd + 1;
			let size: number;
			switch (type) {
				case 1: case 9: case 17: case 18: size = 8; break;
				case 2: {
					const length = bytes.readInt32LE(value);
					if (length < 1 || bytes[value + 3 + length] !== 0) throw new Error('Invalid BSON string');
					size = 4 + length;
					break;
				}
				case 3: case 4:
					size = bytes.readInt32LE(value);
					if (size < 5 || bytes[value + size - 1] !== 0) throw new Error('Invalid nested BSON');
					break;
				case 5:
					size = bytes.readInt32LE(value) + 5;
					if (size < 5) throw new Error('Invalid BSON binary');
					break;
				case 7: size = 12; break;
				case 8: size = 1; break;
				case 10: size = 0; break;
				case 16: size = 4; break;
				default: throw new Error('Unsupported BSON type');
			}
			cursor = value + size;
			if (cursor > end - 1) throw new Error('BSON value exceeds document');
			visit(key, type, value, cursor);
		}
	}

	function slot(start: number, end: number, depth: number) {
		if (depth > 128) throw new Error('Slot nesting limit exceeded');
		slotCount++;
		let children = false;
		let components = false;
		elements(start, end, (key, type, value, next) => {
			if (key === 'Children') {
				if (children || type !== 4) throw new Error('Invalid Children');
				children = true;
				let index = 0;
				elements(value, next, (item, childType, child, childEnd) => {
					if (item !== String(index++) || childType !== 3) throw new Error('Invalid child slot');
					slot(child, childEnd, depth + 1);
				});
			}
			if (key === 'Components') {
				if (components || type !== 3) throw new Error('Invalid Components');
				elements(value, next, (field, fieldType, data, dataEnd) => {
					if (field !== 'Data') return;
					if (components || fieldType !== 4) throw new Error('Invalid component collection');
					components = true;
					let index = 0;
					elements(data, dataEnd, (item, componentType) => {
						if (item !== String(index++) || componentType !== 3) throw new Error('Invalid component');
						componentCount++;
					});
				});
				if (!components) throw new Error('Missing component data');
			}
		});
		if (!children || !components) throw new Error('Incomplete slot');
	}

	elements(0, bytes.length, (key, type, value, next) => {
		if (key !== 'Object') return;
		if (slotCount || type !== 3) throw new Error('Invalid object root');
		slot(value, next, 0);
	});
	if (!slotCount) throw new Error('Missing object root');
	return { slotCount, componentCount };
}

function assetPath(uri: unknown): string | undefined {
	if (typeof uri !== 'string') return;
	const hash = /^packdb:\/\/\/([0-9a-f]{64})(?:\.[a-zA-Z0-9]+)?$/.exec(uri)?.[1];
	return hash && 'Assets/' + hash;
}

async function preview(entry: FileEntry): Promise<string | undefined> {
	const image = await readEntry(entry, 512 * 1024);
	const png = image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
	const jpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
	const webp = image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
	if (!png && !jpeg && !webp) return;
	const thumb = await sharp(image, { limitInputPixels: 4 * MiB }).resize({ width: 192, height: 192, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
	if (thumb.length <= 48 * 1024) return 'data:image/webp;base64,' + thumb.toString('base64');
	return undefined;
}

export async function inspectResonitePackage(path: string): Promise<ResonitePackageInfo | null> {
	let archive: ZipFile | undefined;
	try {
		archive = await ZipFile.open(path, { maxFileBytes: 512 * MiB, maxReadBytes: 4 * MiB });
		const files = new Map<string, FileEntry>();
		const info: ResonitePackageInfo = { schemaVersion: 1, name: '', recordCount: 0, assetCount: 0, assetBytes: 0, unpackedBytes: 0, variantCount: 0 };
		for await (const entry of archive.entries(8192)) {
			if (entry.encrypted || entry.symlink || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) return null;
			files.set(entry.filename, entry);
			info.unpackedBytes += entry.uncompressedSize;
			if (!Number.isSafeInteger(info.unpackedBytes)) return null;
			if (/^[^/]+\.record$/.test(entry.filename)) info.recordCount++;
			if (/^Variants\/[0-9a-f]{64}\/[^/]+$/.test(entry.filename)) info.variantCount++;
			if (/^Assets\/[0-9a-f]{64}$/.test(entry.filename)) {
				info.assetCount++;
				info.assetBytes += entry.uncompressedSize;
			}
		}
		const main = files.get('R-Main.record');
		if (!main) return null;
		const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEntry(main, 256 * 1024)));
		if (record?.id !== 'R-Main' || typeof record.name !== 'string') return null;
		const root = files.get(assetPath(record.assetUri) ?? '');
		if (!root) return null;
		info.name = displayText(record.name, 256);
		if (typeof record.description === 'string' && record.description) info.description = displayText(record.description, 2048);

		try {
			const object = await readEntry(root, 4 * MiB);
			if (object.length >= 9 && object.toString('latin1', 0, 4) === 'FrDT' && object.readUInt32LE(4) === 0 && object[8] === 3) {
				Object.assign(info, countObjectTree(await decompress(object.subarray(9), { maxOutputLength: 8 * MiB })));
			}
		} catch {
			// Object details are optional for unsupported, damaged, or oversized trees.
		}
		const thumb = files.get(assetPath(record.thumbnailUri) ?? '');
		if (thumb) {
			try {
				const url = await preview(thumb);
				if (url) info.thumbnailDataUrl = url;
			} catch {
				// Keep the package statistics when its optional image cannot be decoded.
			}
		}
		return info;
	} catch {
		return null;
	} finally {
		await archive?.close();
	}
}
