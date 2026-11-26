/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { inspectResonitePackage } from '@/misc/resonite-package.js';

function bson(fields: [number, string, Buffer][] = []): Buffer {
	const bytes = Buffer.concat([Buffer.alloc(4), ...fields.flatMap(([type, key, data]) => [Buffer.from([type]), Buffer.from(key + '\0'), data]), Buffer.alloc(1)]);
	bytes.writeInt32LE(bytes.length);
	return bytes;
}

const leaf = bson([[3, 'Components', bson([[4, 'Data', bson()]])], [4, 'Children', bson()]]);
const tree = bson([[3, 'Object', bson([
	[3, 'Components', bson([[4, 'Data', bson([[3, '0', bson()], [3, '1', bson()]])]])],
	[4, 'Children', bson([[3, '0', leaf]])],
])]]);

function object(data: Buffer): Buffer {
	return Buffer.concat([Buffer.from('467244540000000003', 'hex'), brotliCompressSync(data)]);
}

const hash = '1'.repeat(64);
const thumb = '2'.repeat(64);
const record = { id: 'R-Main', name: 'Fixture', description: 'Example', assetUri: 'packdb:///' + hash + '.brson', thumbnailUri: 'packdb:///' + thumb + '.png' };

describe('Resonite package inspection', () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'misskey-resonite-'));
		path = join(dir, 'test.resonitepackage');
	});
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	async function archive(root: Buffer, main = JSON.stringify(record), extra: [string, Buffer][] = [], password?: string) {
		const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
		await zip.add('R-Main.record', new Uint8ArrayReader(Buffer.from(main)), { password });
		await zip.add('Assets/' + hash, new Uint8ArrayReader(root));
		for (const [name, data] of extra) await zip.add(name, new Uint8ArrayReader(data));
		const bytes = Buffer.from(await zip.close());
		await writeFile(path, bytes);
		return bytes;
	}

	test('counts entries and slot-attached components and decodes the local thumbnail', async () => {
		const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
		const data = object(tree);
		await archive(data, JSON.stringify(record), [['Assets/' + thumb, image], ['Variants/' + thumb + '/small', Buffer.alloc(8)]]);
		expect(await inspectResonitePackage(path)).toEqual({
			schemaVersion: 1, name: 'Fixture', description: 'Example', recordCount: 1, slotCount: 2, componentCount: 2,
			assetCount: 2, assetBytes: image.length + data.length, variantCount: 1,
			unpackedBytes: Buffer.byteLength(JSON.stringify(record)) + image.length + data.length + 8,
			thumbnailDataUrl: expect.stringMatching(/^data:image\/webp;base64,/),
		});
	});

	test.each([
		['unsupported object compression', Buffer.from('467244540000000001', 'hex')],
		['malformed object', object(Buffer.from([5, 0, 0, 0, 1]))],
		['oversized BSON', object(Buffer.alloc(8 * 1024 * 1024 + 1))],
	])('omits unknown statistics for %s', async (_label, data) => {
		await archive(data);
		expect(await inspectResonitePackage(path)).toEqual(expect.objectContaining({ assetCount: 1 }));
		expect(await inspectResonitePackage(path)).not.toHaveProperty('slotCount');
	});

	test('ignores external thumbnails', async () => {
		await archive(object(tree), JSON.stringify({ ...record, thumbnailUri: 'https://example.invalid/image.png' }));
		expect(await inspectResonitePackage(path)).not.toHaveProperty('thumbnailDataUrl');
	});

	test('rejects malformed, oversized and encrypted main records', async () => {
		for (const main of ['{', JSON.stringify({ ...record, description: 'X'.repeat(256 * 1024) })]) {
			await archive(object(tree), main);
			expect(await inspectResonitePackage(path)).toBeNull();
		}
		await archive(object(tree), JSON.stringify(record), [], 'test');
		expect(await inspectResonitePackage(path)).toBeNull();
	});

	test('rejects duplicate main records', async () => {
		const zip = await archive(object(tree), JSON.stringify(record), [['R-Twin.record', Buffer.alloc(0)]]);
		for (let i = zip.indexOf('R-Twin.record'); i !== -1; i = zip.indexOf('R-Twin.record', i + 1)) {
			zip.write('R-Main.record', i);
		}
		await writeFile(path, zip);
		expect(await inspectResonitePackage(path)).toBeNull();
	});
});
