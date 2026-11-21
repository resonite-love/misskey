/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { SyncEmoji } from '@/core/gridspace/emoji-sync-protocol.js';

@Entity('gridspace_emoji_sync')
@Index('IDX_gridspace_emoji_sync_peer_state', ['peerOrigin', 'state'])
@Index('IDX_gridspace_emoji_sync_a', ['peerOrigin', 'aId'], { unique: true })
@Index('IDX_gridspace_emoji_sync_b', ['peerOrigin', 'bId'], { unique: true })
export class MiGridspaceEmojiSync {
	@PrimaryColumn('uuid') public id: string;
	@Column('varchar', { length: 512 }) public peerOrigin: string;
	@Column('varchar', { length: 32, nullable: true }) public aId: string | null;
	@Column('varchar', { length: 32, nullable: true }) public bId: string | null;
	@Column('varchar', { length: 64, nullable: true }) public hashA: string | null;
	@Column('varchar', { length: 64, nullable: true }) public hashB: string | null;
	@Column('jsonb', { nullable: true }) public a: SyncEmoji | null;
	@Column('jsonb', { nullable: true }) public b: SyncEmoji | null;
	@Column('jsonb', { nullable: true }) public pending: { id: string; sourceHash: string; targetHash: string | null; toA: boolean } | null;
	@Column('varchar', { length: 16 }) public state: 'pending' | 'synced' | 'conflict' | 'failed' | 'ignored';
	@Column('varchar', { length: 64, nullable: true }) public reason: string | null;
	@Column('integer', { default: 0 }) public attempts: number;
	@Column('timestamp with time zone') public updatedAt: Date;
	@Column('timestamp with time zone') public retryAt: Date;
}

@Entity('gridspace_emoji_receipt')
export class MiGridspaceEmojiReceipt {
	@PrimaryColumn('varchar', { length: 64 }) public id: string;
	@Column('varchar', { length: 512 }) public peerOrigin: string;
	@Column('varchar', { length: 32 }) public emojiId: string;
	@Column('jsonb') public result: SyncEmoji;
	@Index('IDX_gridspace_emoji_receipt_created') @Column('timestamp with time zone') public createdAt: Date;
}

@Entity('gridspace_emoji_state')
export class MiGridspaceEmojiState {
	@PrimaryColumn('varchar', { length: 512 }) public peerOrigin: string;
	@Column('timestamp with time zone') public checkedAt: Date;
	@Column('varchar', { length: 64, nullable: true }) public lastError: string | null;
}
