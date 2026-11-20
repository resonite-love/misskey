/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type ReactionSource = { reaction: string; count: number; version?: string | number };
export type ReactionGroup = { reaction: string; action: string; count: number; sources: ReactionSource[] };

/** Raw keys remain available for removal and reactor lists; only the button is grouped. */
export function groupReactions(reactions: Record<string, number>, aliases: Readonly<Record<string, string>>, localHost: string, sourceHost = localHost, versions?: number | Record<string, string>): ReactionGroup[] {
	const groups = new Map<string, ReactionGroup>();
	for (const [raw, count] of Object.entries(reactions)) {
		if (!count) continue;
		const qualified = raw.replace(/^:([\w+-]+)(?:@\.)?:$/, `:$1@${sourceHost}:`);
		const local = qualified.endsWith(`@${localHost}:`) ? qualified.slice(0, -localHost.length - 2) + '@.:' : undefined;
		const reaction = aliases[qualified] ?? local ?? qualified;
		const action = sourceHost === localHost ? reaction : reaction.replace(/^:([\w+-]+)@\.:$/, `:$1@${localHost}:`);
		const group = groups.get(reaction) ?? { reaction, action, count: 0, sources: [] };
		group.count += count;
		group.sources.push({ reaction: raw, count, version: typeof versions === 'object' ? versions[raw] : versions });
		groups.set(reaction, group);
	}
	return [...groups.values()];
}
