/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref } from 'vue';

export const sharedAntennaUnavailable = ref(false);
type Kind = 'antenna' | 'page' | 'clip' | 'gallery';
type Data = Record<string, unknown>;
type Call = (path: string, data: Data) => Promise<unknown>;
const paths: Record<string, { kind: Kind; key: string }> = {
	antennas: { kind: 'antenna', key: 'antennaId' }, pages: { kind: 'page', key: 'pageId' },
	clips: { kind: 'clip', key: 'clipId' }, 'gallery/posts': { kind: 'gallery', key: 'postId' },
};
export function parseManagedId(value: unknown) {
	if (typeof value !== 'string') return null;
	const match = /^gridspace:(antenna|page|clip|gallery):([a-zA-Z0-9]{1,32})$/.exec(value);
	return match ? { kind: match[1] as Kind, id: match[2] } : null;
}
export function managedId(kind: Kind, id: string) { return `gridspace:${kind}:${id}`; }

/** Adapt only known resource operations; all other Misskey requests remain untouched. */
export function routeManagedApi(endpoint: string, data: Data, call: Call): Promise<unknown> | undefined {
	for (const [prefix, { kind, key }] of Object.entries(paths)) {
		const action = endpoint.slice(prefix.length + 1);
		if (!endpoint.startsWith(prefix + '/') || !['show', 'update', 'delete', ...(kind === 'clip' ? ['add-note', 'remove-note'] : []), ...(['page', 'gallery'].includes(kind) ? ['like', 'unlike'] : [])].includes(action)) continue;
		const parsed = parseManagedId(data[key]);
		if (parsed?.kind !== kind) continue;
		const { [key]: _id, i: _token, ...values } = data;
		return call('gridspace/managed-resource', { kind, action, id: parsed.id, data: values }).then(response => {
			const result = response as { item: unknown; clipNoteError?: string };
			if (result.clipNoteError === 'already-added') throw Object.assign(new Error('The note has already been clipped.'), { id: '734806c4-542c-463a-9311-15c512803965', code: 'ALREADY_CLIPPED' });
			if (result.clipNoteError === 'too-many') throw Object.assign(new Error('You cannot add notes to the clip any more.'), { id: 'f0dba960-ff73-4615-8df4-d6ac5d9dc118', code: 'TOO_MANY_CLIP_NOTES' });
			return result.item ?? undefined;
		});
	}
	if (endpoint === 'antennas/list') {
		const peer = call('gridspace/managed-resource', { kind: 'antenna', action: 'list' }).then(value => {
			sharedAntennaUnavailable.value = false;
			return value;
		}).catch(() => { sharedAntennaUnavailable.value = true; return { enabled: false, items: [], aliases: [] }; });
		return Promise.all([call(endpoint, data), peer]).then(([local, value]) => {
			const remote = value as { enabled: boolean; items: Data[]; aliases: { targetId: string }[] };
			const aliases = new Set(remote.aliases.map(row => row.targetId));
			return [...(local as Data[]).filter(row => !aliases.has(String(row.id))), ...remote.items];
		});
	}
	return undefined;
}
