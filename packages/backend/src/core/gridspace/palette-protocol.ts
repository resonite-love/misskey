/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export { GRIDSPACE_PALETTE_SCOPE } from './link-crypto.js';
export const GRIDSPACE_PALETTE_REGISTRY_SCOPE = ['client', 'gridspace'];
export const GRIDSPACE_PALETTE_REGISTRY_KEY = 'emojiPalette';

export type GridspacePalette = {
	version: 1;
	palettes: { id: string; name: string; emojis: string[] }[];
	forMain: string | null;
	forReaction: string | null;
	recentlyUsedEmojis?: string[];
};

/** Only palette preferences and the explicitly exported browser emoji history cross the boundary. */
export function parseGridspacePalette(value: unknown): GridspacePalette | null {
	if (value == null || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144) return null;
	const input = value as Record<string, unknown>;
	if (input.version !== 1 || !Array.isArray(input.palettes) || input.palettes.length > 100) return null;
	const ids = new Set<string>();
	const palettes: GridspacePalette['palettes'] = [];
	let total = 0;
	for (const item of input.palettes) {
		if (item == null || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 1024 || ids.has(item.id) ||
			typeof item.name !== 'string' || item.name.length > 256 || !Array.isArray(item.emojis) || item.emojis.length > 10000 ||
			item.emojis.some((emoji: unknown) => typeof emoji !== 'string' || emoji.length > 512)) return null;
		total += item.emojis.length;
		if (total > 10000) return null;
		ids.add(item.id);
		palettes.push({ id: item.id, name: item.name, emojis: [...item.emojis] });
	}
	for (const key of ['forMain', 'forReaction']) {
		if (input[key] !== null && (typeof input[key] !== 'string' || !ids.has(input[key] as string))) return null;
	}
	if (input.recentlyUsedEmojis !== undefined && (!Array.isArray(input.recentlyUsedEmojis) || input.recentlyUsedEmojis.length > 32 ||
		input.recentlyUsedEmojis.some(emoji => typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 512))) return null;
	return { version: 1, palettes, forMain: input.forMain as string | null, forReaction: input.forReaction as string | null,
		...(input.recentlyUsedEmojis !== undefined ? { recentlyUsedEmojis: [...input.recentlyUsedEmojis as string[]] } : {}) };
}
