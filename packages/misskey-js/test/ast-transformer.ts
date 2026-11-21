import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import ts from 'typescript';
import { printWithoutNeverProperties } from '../generator/src/ast-transformer.js';

describe('OpenAPI type generation', () => {
	test('preserves empty paragraphs in generated API documentation without trailing spaces', async () => {
		const documentation = await readFile(new URL('../src/autogen/apiClientJSDoc.ts', import.meta.url), 'utf8');
		expect(documentation).toMatch(/^     \*\r?$/m);
		expect(documentation).not.toMatch(/^     \*[\t ]+\r?$/m);
	});

	test('preserves string enum members while pruning unavailable operations', () => {
		const factory = ts.factory;
		const enumType = factory.createUnionTypeNode(['通常', 'a"b'].map(value =>
			factory.createIdentifier(JSON.stringify(value)) as unknown as ts.TypeNode));
		const property = (name: string, type: ts.TypeNode) => factory.createPropertySignature(undefined, name, undefined, type);
		const paths = factory.createTypeAliasDeclaration(undefined, 'paths', undefined, factory.createTypeLiteralNode([
			property('unavailable', factory.createTypeLiteralNode([property('get', factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword))])),
			property('status', enumType),
		]));
		const result = printWithoutNeverProperties([paths]);
		expect(result).not.toContain('unavailable');
		expect(result).toContain(['"通常"', JSON.stringify('a"b')].join(' | '));
	});
});
