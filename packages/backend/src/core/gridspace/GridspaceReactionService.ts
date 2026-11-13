/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { ExtendedReactionService } from '@/core/ExtendedReactionService.js';
import { legacyReactions } from '@/core/ReactionService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { IdService } from '@/core/IdService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { Packed } from '@/misc/json-schema.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceReactionDeliveryService } from './GridspaceReactionDeliveryService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { gridspaceNoteId } from './note-protocol.js';
import { searchNoteTimeSql } from './search-visibility.js';
import { canonicalReaction, localReaction, compareReactionRows, encodeReactionPosition, reactionPosition, validateReactionSnapshots, supportsGridspaceReactions, supportsGridspaceChannelReactions, GRIDSPACE_REACTIONS_PATH, type ReactionPeerRequest, type ReactionPosition, type ReactionRow, type ReactionSnapshot, type ReactionPreview } from './reaction-protocol.js';

// A reactor's home server owns its complete set. Do not add a peer's replicated
// ActivityPub primary reaction a second time, or resurrect it after cancellation.
// Only the compile-time legacy map is interpolated; request data remains bound parameters.
const normalizedReaction = `CASE reaction ${Object.entries(legacyReactions).map(([old, emoji]) => `WHEN '${old}' THEN '${emoji}'`).join(' ')} ELSE reaction END`;
const ownedRows = `SELECT DISTINCT ON (r."userId", r.reaction) r.*, u.uri AS "userUri", u.host AS "userHost"
	FROM (SELECT id, "noteId", "userId", ${normalizedReaction} AS reaction FROM note_reaction
	UNION ALL SELECT id, "noteId", "userId", ${normalizedReaction} AS reaction FROM extended_note_reaction) r
	INNER JOIN "user" u ON u.id = r."userId"
	WHERE r."noteId" = $1 AND (($2::boolean AND u.host IS NULL) OR (NOT $2::boolean AND u.host IS DISTINCT FROM $3))
	ORDER BY r."userId", r.reaction, r.id`;

@Injectable()
export class GridspaceReactionService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly reactionTime: string;
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) config: Config,
		private extended: ExtendedReactionService,
		private search: GridspaceSearchService,
		private emojis: CustomEmojiService,
		private ids: IdService,
		private people: ApPersonService,
		private users: UserEntityService,
		private delivery: GridspaceReactionDeliveryService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.reactionTime = searchNoteTimeSql(config.id).replaceAll('note.id', 'r.id');
	}

	private uri(note: MiNote): string { return note.uri ?? `${this.peer!.origin}/notes/${note.id}`; }

	private shared(note: MiNote): boolean {
		return supportsGridspaceReactions(note, this.peer);
	}

	/** Bounded display data travels with the authorized note batch, never per-button polling. */
	private async previews(note: MiNote, shared: boolean): Promise<ReactionPreview[]> {
		const allRows = `SELECT DISTINCT ON ("userId", reaction) * FROM (
			SELECT id, "userId", ${normalizedReaction} AS reaction FROM note_reaction WHERE "noteId" = $1
			UNION ALL SELECT id, "userId", ${normalizedReaction} AS reaction FROM extended_note_reaction WHERE "noteId" = $1
		) r ORDER BY "userId", reaction, id`;
		const rows: { reaction: string; userId: string }[] = await this.db.query(`SELECT r.reaction, r."userId" FROM (${shared ? ownedRows : allRows}) r ORDER BY r.id DESC LIMIT 20`,
			shared ? [note.id, note.userHost !== null, new URL(this.peer!.peerOrigin).host] : [note.id]);
		if (!rows.length) return [];
		const users = new Map((await this.db.getRepository(MiUser).findBy({ id: In(rows.map(row => row.userId)) })).map(user => [user.id, user]));
		return rows.flatMap(row => {
			const user = users.get(row.userId);
			return user ? [{ reaction: canonicalReaction(row.reaction, this.peer!.origin), account: {
				uri: user.uri ?? `${this.peer!.origin}/users/${user.id}`, username: user.username, name: user.name,
				host: user.host ?? new URL(this.peer!.origin).host, avatarUrl: (user.avatarId == null ? null : user.avatarUrl) ?? this.users.getIdenticonUrl(user),
			} }] : [];
		});
	}

	private async visible(notes: MiNote[], viewer: { id: string } | null, authenticated = viewer != null): Promise<MiNote[]> {
		if (!notes.length) return [];
		// A signed peer can attest a login before its actor has been cached here.
		// The impossible ID grants no author/follower/recipient privileges.
		const queryViewer = viewer ?? (authenticated ? { id: '' } : null);
		const rows = await this.search.read(this.search.noteQuery(queryViewer, { query: '' }, false, authenticated)
			.select('note.id').orderBy()
			.andWhere('note.id IN (:...reactionNotes)', { reactionNotes: notes.map(note => note.id) }));
		const allowed = new Set(rows.map(note => note.id));
		return notes.filter(note => allowed.has(note.id));
	}

	private async snapshot(note: MiNote, input: ReactionPeerRequest): Promise<ReactionSnapshot> {
		const peer = this.peer!;
		const params = [note.id, note.userHost !== null, new URL(peer.peerOrigin).host];
		// Reactor pages do not consume counts or emoji metadata.
		const counts: { reaction: string; count: string; revision: string }[] = input.mode === 'list' ? [] : await this.db.query(
			`SELECT r.reaction, COUNT(*) AS count, md5(string_agg(r.id, ',' ORDER BY r.id)) AS revision FROM (${ownedRows}) r GROUP BY r.reaction ORDER BY r.reaction`, params);
		const reactions = Object.fromEntries(counts.map(row => [canonicalReaction(row.reaction, peer.origin), Number(row.count)]));
		const custom = counts.map(row => row.reaction).filter(value => value.startsWith(':')).map(value => value.slice(1, -1));
		const emojiUrls = custom.length ? await this.emojis.populateEmojis(custom, null) : {};
		const localEmojis = custom.length ? await this.emojis.localEmojisCache.fetch() : new Map();
		for (const name of custom) {
			const emoji = localEmojis.get(name.replace(/@\.$/, ''));
			if (emoji) emojiUrls[name] = emoji.publicUrl || emoji.originalUrl;
		}
		const reactionEmojis = Object.fromEntries(Object.entries(emojiUrls).map(([key, value]) => [canonicalReaction(`:${key}:`, peer.origin).slice(1, -1), value]));
		const revision = createHash('sha256').update(JSON.stringify(counts)).digest('hex');
		const reactionVersions = Object.fromEntries(counts.map(row => [canonicalReaction(row.reaction, peer.origin), row.revision]));
		const result: ReactionSnapshot = { uri: this.uri(note), reactions, reactionEmojis, revision, reactionVersions, reactionAcceptance: note.reactionAcceptance };
		if (input.withPreviews && input.mode === 'show') result.previews = (await this.previews(note, true)).filter(row => Object.hasOwn(reactions, row.reaction));
		if (input.mode === 'list') {
			const rows: { id: string; userId: string; userUri: string | null; userHost: string | null; reaction: string; time: string }[] = await this.db.query(`
				SELECT r.*, ${this.reactionTime} AS time FROM (${ownedRows}) r
				WHERE ($4::varchar IS NULL OR r.reaction = $4)
				AND ($5::bigint IS NULL OR (${this.reactionTime}, r.id COLLATE "C", $8::text COLLATE "C") < ($5, $6::text COLLATE "C", $7::text COLLATE "C"))
				AND ($9::bigint IS NULL OR (${this.reactionTime}, r.id COLLATE "C", $8::text COLLATE "C") > ($9, $10::text COLLATE "C", $11::text COLLATE "C"))
				ORDER BY time ${input.after ? 'ASC' : 'DESC'}, r.id COLLATE "C" ${input.after ? 'ASC' : 'DESC'} LIMIT $12`,
			[...params, input.type ? localReaction(input.type, peer.origin).replace('@.:', ':') : null,
				input.before?.time ?? null, input.before?.id ?? null, input.before?.origin ?? null, peer.origin,
				input.after?.time ?? null, input.after?.id ?? null, input.after?.origin ?? null, input.limit ?? 10]);
			result.rows = rows.map(row => ({ id: row.id, time: Number(row.time), origin: peer.origin, reaction: canonicalReaction(row.reaction, peer.origin),
				userUri: row.userUri ?? `${peer.origin}/users/${row.userId}` }));
		}
		return result;
	}

	/** Only the authenticated paired server reaches this method. No recursive peer reads. */
	public async peerRead(input: ReactionPeerRequest): Promise<ReactionSnapshot[]> {
		if (!this.peer) throw new Error('GridSpace disabled');
		const ids = input.uris.filter(uri => uri.startsWith(`${this.peer!.origin}/notes/`)).map(uri => uri.slice(`${this.peer!.origin}/notes/`.length)).filter(gridspaceNoteId);
		const remoteUris = input.uris.filter(uri => uri.startsWith(`${this.peer!.peerOrigin}/notes/`) && gridspaceNoteId(uri.slice(`${this.peer!.peerOrigin}/notes/`.length)));
		const notes = (ids.length || remoteUris.length) ? await this.db.getRepository(MiNote).findBy([{ id: In(ids), userHost: IsNull() }, { uri: In(remoteUris) }]) : [];
		const viewer = input.viewerId ? await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${input.viewerId}`, host: new URL(this.peer.peerOrigin).host }) : null;
		const candidates = notes.filter(note => this.shared(note));
		// For our notes we enforce the requesting viewer's source-side ACL. For
		// cached peer notes, the authenticated requester IS the source server: it
		// has already checked its viewer and receives only our local contributions.
		// Its local follower relationships are not replicated onto this server.
		const local = candidates.filter(note => note.userHost === null);
		const sourceOwned = candidates.filter(note => note.userHost !== null);
		const visible = [...await this.visible(local, viewer, input.viewerId != null), ...sourceOwned];
		const packed = await Promise.all(visible.map(note => this.snapshot(note, input)));
		// Policies and blocks may change while counts/users are being collected.
		const fresh = new Set([...await this.visible(local, viewer, input.viewerId != null), ...sourceOwned].map(note => this.uri(note)));
		return packed.filter(state => fresh.has(state.uri));
	}

	private async remote(input: ReactionPeerRequest): Promise<ReactionSnapshot[]> {
		const result = await requestGridspacePeer(this.peer!, GRIDSPACE_REACTIONS_PATH, input, 2 * 1024 * 1024, Date.now() + 8000);
		return validateReactionSnapshots(result, input, this.peer!.peerOrigin);
	}

	public async show(noteIds: string[], me: { id: string } | null, withPreviews = false) {
		const notes = await this.db.getRepository(MiNote).findBy({ id: In(noteIds) });
		const shared = (await this.visible(notes.filter(note => this.shared(note)), me));
		const input: ReactionPeerRequest = { mode: 'show', uris: shared.map(note => this.uri(note)), viewerId: me?.id, ...(withPreviews ? { withPreviews: true } : {}) };
		let remote: ReactionSnapshot[] | null = [];
		if (shared.length) { try { remote = await this.remote(input); } catch { remote = null; } }
		const base = await this.extended.show(noteIds, me, new Set(remote === null ? [] : shared.map(note => note.id)));
		const result = [];
		for (const state of base) {
			const note = notes.find(item => item.id === state.noteId)!;
			if (!this.shared(note)) { result.push({ ...state, shared: false, complete: true, reactionPreviews: withPreviews ? (await this.previews(note, false)).map(row => ({ ...row, reaction: localReaction(row.reaction, this.peer!.origin) })) : undefined }); continue; }
			if (!shared.some(item => item.id === note.id)) continue;
			if (remote === null) { result.push({ ...state, shared: true, complete: false, reactionPreviews: undefined }); continue; }
			const other = remote.find(item => item.uri === this.uri(note));
			if (note.userHost !== null && !other) continue;
			const own = await this.snapshot(note, input);
			const reactions = { ...own.reactions };
			for (const [key, count] of Object.entries(other?.reactions ?? {})) reactions[key] = (reactions[key] ?? 0) + count;
			// Older peers have no per-emoji versions: keep their whole-note fallback.
			const reactionVersions = !other || other.reactionVersions ? Object.fromEntries(Object.keys(reactions).map(key =>
				[localReaction(key, this.peer!.origin), `${own.reactionVersions?.[key] ?? ''}:${other?.reactionVersions?.[key] ?? ''}`])) : undefined;
			result.push({ ...state, shared: true, complete: true, reactionVersions, revision: own.revision + (other?.revision ?? ''),
				reactionPreviews: withPreviews ? [...own.previews ?? [], ...other?.previews ?? []].slice(0, 20).map(row => ({ ...row, reaction: localReaction(row.reaction, this.peer!.origin) })) : undefined,
				reactions: Object.fromEntries(Object.entries(reactions).map(([key, value]) => [localReaction(key, this.peer!.origin), value])),
				reactionEmojis: Object.fromEntries(Object.entries({ ...own.reactionEmojis, ...other?.reactionEmojis }).map(([key, value]) => [localReaction(`:${key}:`, this.peer!.origin).slice(1, -1), value])),
			});
		}
		const push = shared.length > 0 && await this.delivery.supportsPush();
		const allowed = new Set((await this.visible(shared, me)).map(note => note.id));
		return result.filter(state => !state.shared || allowed.has(state.noteId)).map(state => ({ ...state, push: state.shared && push }));
	}

	public async prepareMutation(user: MiLocalUser, note: MiNote): Promise<MiNote> {
		if (note.userHost === null || supportsGridspaceChannelReactions(note, this.peer)) return note;
		if (!this.shared(note)) throw new IdentifiableError('extended-local-only');
		if (!(await this.visible([note], user)).length) throw new IdentifiableError('68e9d2d1-48bf-42c2-b90a-b20e09fd3d48');
		let state: ReactionSnapshot | undefined;
		try { state = (await this.remote({ mode: 'show', uris: [this.uri(note)], viewerId: user.id }))[0]; } catch { throw new IdentifiableError('gridspace-reactions-unavailable'); }
		if (!state) throw new IdentifiableError('68e9d2d1-48bf-42c2-b90a-b20e09fd3d48');
		const policy = state.reactionAcceptance;
		return { ...note, reactionAcceptance: policy === 'likeOnlyForRemote' || policy === 'nonSensitiveOnlyForLocalLikeOnlyForRemote' ? 'likeOnly' : policy as MiNote['reactionAcceptance'] };
	}

	public async create(user: MiLocalUser, note: MiNote, reaction: string) {
		return this.extended.create(user, await this.prepareMutation(user, note), reaction, this.shared(note) || supportsGridspaceChannelReactions(note, this.peer));
	}

	public async delete(user: MiLocalUser, note: MiNote, reaction: string) {
		return this.extended.delete(user, await this.prepareMutation(user, note), reaction, this.shared(note) || supportsGridspaceChannelReactions(note, this.peer));
	}

	public async list(note: MiNote, me: { id: string } | null, type: string | null | undefined, limit: number, sinceId?: string, untilId?: string): Promise<Packed<'NoteReaction'>[]> {
		if (!this.shared(note)) return this.extended.list(note, me, type, limit, sinceId, untilId);
		if (!(await this.visible([note], me)).length) return [];
		const position = (value: string | undefined): ReactionPosition | undefined => {
			if (!value) return undefined;
			try {
				const decoded = reactionPosition(value, [this.peer!.origin, this.peer!.peerOrigin]);
				if (decoded) return decoded;
				if (!gridspaceNoteId(value)) throw new Error('Invalid ID');
				const time = this.ids.parse(value).date.getTime();
				if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid time');
				return { time, id: value, origin: this.peer!.origin };
			} catch { throw new IdentifiableError('gridspace-reactions-cursor'); }
		};
		const input: ReactionPeerRequest = { mode: 'list', uris: [this.uri(note)], viewerId: me?.id, type: type ? canonicalReaction(type, this.peer!.origin) : type, limit, before: position(untilId), after: position(sinceId) };
		let other: ReactionSnapshot | undefined;
		try { other = (await this.remote(input))[0]; } catch { throw new IdentifiableError('gridspace-reactions-unavailable'); }
		if (note.userHost !== null && !other) return [];
		const own = await this.snapshot(note, input);
		const rows = [...own.rows!, ...(other?.rows ?? [])].sort((a, b) => compareReactionRows(a, b) * (input.after ? 1 : -1)).slice(0, limit);
		const result: Packed<'NoteReaction'>[] = [];
		for (const row of rows) {
			const localPrefix = `${this.peer!.origin}/users/`;
			// Keep the whole page retryable instead of skipping an unavailable actor and
			// returning a short page that incorrectly signals the end of pagination.
			const user = row.userUri.startsWith(localPrefix) ? await this.db.getRepository(MiUser).findOneBy({ id: row.userUri.slice(localPrefix.length), host: IsNull() }) : await this.people.resolvePerson(row.userUri).catch(() => { throw new IdentifiableError('gridspace-reactions-unavailable'); });
			if (!user) continue;
			result.push({ id: encodeReactionPosition(row), createdAt: new Date(row.time).toISOString(), type: localReaction(row.reaction, this.peer!.origin), user: await this.users.pack(user, me) });
		}
		return (await this.visible([note], me)).length ? result : [];
	}
}
