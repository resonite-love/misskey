/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Column } from '@/deck.js';

export const layoutSettingKeys = ['uploadFolder', 'widgets', 'deck.profiles', 'deck.profile', 'deck.wallpaper'] as const;
type Row = Record<string, any>;
export type LayoutReferenceKind = 'folder' | 'file' | 'list' | 'antenna' | 'clip' | 'channel';
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);

function json(value: unknown, depth = 0): boolean {
	if (depth > 10) return false;
	if (value === null || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value === 'string') return value.length <= 65536;
	if (Array.isArray(value)) return value.length <= 512 && value.every(item => json(item, depth + 1));
	return !!value && typeof value === 'object' && Object.keys(value).length <= 128 && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && json(item, depth + 1));
}

export function validLayoutSetting(key: string, value: unknown): boolean {
	if (key === 'uploadFolder') return value === null || typeof value === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(value);
	if (key === 'deck.profile') return value === null || typeof value === 'string' && value.length <= 128;
	if (key === 'deck.wallpaper') return value === null || typeof value === 'string' && /^https?:\/\//.test(value) && value.length <= 4096;
	if (!json(value)) return false;
	if (key === 'widgets') return Array.isArray(value) && value.length <= 100 && value.every(widget => widget && id(widget.id) && typeof widget.name === 'string' && widget.name.length <= 100 && widget.data && typeof widget.data === 'object' && !Array.isArray(widget.data));
	if (key !== 'deck.profiles' || !Array.isArray(value) || value.length > 30) return false;
	return value.every(profile => {
		if (!profile || !id(profile.id) || typeof profile.name !== 'string' || profile.name.length > 128 || !Array.isArray(profile.columns) || profile.columns.length > 100 || !Array.isArray(profile.layout)) return false;
		const ids = new Set(profile.columns.map((column: Row) => column.id));
		const arranged = profile.layout.flat();
		return ids.size === profile.columns.length && profile.columns.every((column: Row) => id(column.id) && typeof column.type === 'string' && Number.isFinite(column.width) && column.width >= 100 && column.width <= 4000) &&
			profile.layout.every((group: unknown) => Array.isArray(group) && group.length > 0) && arranged.length === ids.size && new Set(arranged).size === ids.size && arranged.every((column: unknown) => ids.has(column));
	});
}

/** Translate known resource references only; never treat a coincident local ID as the source. */
export async function mapLayoutSettings(values: Row, resolve: (kind: LayoutReferenceKind, id: string) => Promise<{ id: string; name?: string }>, notice: string) {
	const result = structuredClone(values);
	const issues: string[] = [];
	const cache = new Map<string, Promise<{ id: string; name?: string }>>();
	const ref = (kind: LayoutReferenceKind, value: string) => {
		const key = `${kind}:${value}`;
		if (!cache.has(key)) cache.set(key, resolve(kind, value));
		return cache.get(key)!;
	};
	const sound = async (data: Row) => {
		if (data.type === '_driveFile_' && data.fileId) data.fileId = (await ref('file', data.fileId)).id;
	};
	const widget = async (item: Row) => {
		try {
			if (item.data.folderId) item.data.folderId = (await ref('folder', item.data.folderId)).id;
			if (item.data.listId) item.data.listId = (await ref('list', item.data.listId)).id;
			if (item.data.list?.id) item.data.list = await ref('list', item.data.list.id);
			if (item.data.antenna?.id) item.data.antenna = await ref('antenna', item.data.antenna.id);
			if (item.name === 'aiscriptApp') item.data.runAutomatically = false;
		} catch { issues.push(item.name); item.data.gridspaceImportError = notice; }
	};
	if (result.uploadFolder) {
		try { result.uploadFolder = (await ref('folder', result.uploadFolder)).id; } catch { delete result.uploadFolder; issues.push('uploadFolder'); }
	}
	for (const item of result.widgets ?? []) await widget(item);
	for (const profile of result['deck.profiles'] ?? []) {
		for (const column of profile.columns as (Column & Row)[]) {
			try {
				for (const kind of ['list', 'antenna', 'channel', 'clip'] as const) {
					const sourceId = column[`${kind}Id`];
					if (sourceId) column[`${kind}Id`] = (await ref(kind, sourceId)).id;
				}
				if (column.type === 'roleTimeline') throw new Error('Server-specific role');
				if (column.soundSetting) await sound(column.soundSetting);
				for (const item of column.widgets ?? []) await widget(item);
			} catch { issues.push(`${profile.name}: ${column.name || column.type}`); column.gridspaceImportError = notice; }
		}
	}
	return { values: result, issues };
}
