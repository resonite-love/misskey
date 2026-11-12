/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MiUser } from './User.js';
import { id } from './util/id.js';

export type GridspaceSnapshotItem = { uri: string; withReplies: boolean; skip: string | null };

@Entity('gridspace_link')
@Index(['localUserId', 'peerOrigin', 'peerUserId'], { unique: true })
@Index('IDX_gridspace_active_local', ['localUserId'], { unique: true, where: '"state" <> \'revoked\'' })
@Index('IDX_gridspace_active_peer', ['peerOrigin', 'peerUserId'], { unique: true, where: '"state" <> \'revoked\'' })
export class MiGridspaceLink {
	@PrimaryColumn('uuid') public id: string;
	@Column(id()) public localUserId: string;
	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' }) @JoinColumn() public localUser: MiUser | null;
	@Column('varchar', { length: 512 }) public peerOrigin: string;
	@Column(id()) public peerUserId: string;
	@Column('varchar', { length: 128 }) public peerUsername: string;
	@Column('integer', { default: 1 }) public generation: number;
	@Column('boolean') public initiator: boolean;
	@Column('varchar', { length: 16 }) public state: 'preparing' | 'active' | 'revoked';
	@Column('text', { nullable: true }) public tokenCipher: string | null;
	@Column('jsonb', { nullable: true }) public snapshot: GridspaceSnapshotItem[] | null;
	@Column('timestamp with time zone', { nullable: true }) public snapshotAt: Date | null;
	@Column('timestamp with time zone') public createdAt: Date;
	@Column('varchar', { length: 64, nullable: true }) public lastError: string | null;
}

@Entity('gridspace_auth_session')
export class MiGridspaceAuthSession {
	@PrimaryColumn('uuid') public id: string;
	@Index() @Column(id()) public localUserId: string;
	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' }) @JoinColumn() public localUser: MiUser | null;
	@Index({ unique: true }) @Column('varchar', { length: 64 }) public stateHash: string;
	@Column('varchar', { length: 64 }) public clientHash: string;
	@Column('text') public verifierCipher: string;
	@Column('text', { nullable: true }) public tokenCipher: string | null;
	@Column('boolean', { default: false }) public exchanged: boolean;
	@Column('boolean', { default: false }) public completed: boolean;
	@Column('uuid', { nullable: true }) public linkId: string | null;
	@Column('integer', { nullable: true }) public generation: number | null;
	@Column('timestamp with time zone') public createdAt: Date;
	@Index() @Column('timestamp with time zone') public expiresAt: Date;
}

@Entity('gridspace_import_item')
@Index(['linkId', 'actorUri'], { unique: true })
export class MiGridspaceImportItem {
	@PrimaryColumn('uuid') public id: string;
	@Column('uuid') public linkId: string;
	@ManyToOne(() => MiGridspaceLink, { onDelete: 'CASCADE' }) @JoinColumn() public link: MiGridspaceLink | null;
	@Column('varchar', { length: 512 }) public actorUri: string;
	@Column('boolean', { default: false }) public withReplies: boolean;
	@Index() @Column('varchar', { length: 16 }) public state: 'pending' | 'requested' | 'done' | 'skipped' | 'failed' | 'cancelled';
	@Column('varchar', { length: 64, nullable: true }) public reason: string | null;
	@Column({ ...id(), nullable: true }) public targetUserId: string | null;
	@ManyToOne(() => MiUser, { onDelete: 'SET NULL' }) @JoinColumn() public targetUser: MiUser | null;
}

@Entity('gridspace_follow_override')
export class MiGridspaceFollowOverride {
	@PrimaryColumn(id()) public localUserId: string;
	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' }) @JoinColumn() public localUser: MiUser | null;
	@PrimaryColumn(id()) public targetUserId: string;
	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' }) @JoinColumn() public targetUser: MiUser | null;
	@Column('timestamp with time zone') public changedAt: Date;
}

/** No FK: deletion of the source note must not remove its pending delivery. */
@Entity('gridspace_note_delivery')
export class MiGridspaceNoteDelivery {
	@PrimaryColumn(id()) public noteId: string;
	@Column('uuid') public version: string;
	@Column('varchar', { length: 512 }) public peerOrigin: string;
	@Index() @Column('timestamp with time zone') public retryAt: Date;
	@Column('integer', { default: 0 }) public attempts: number;
}

/** Permanent tombstones also guard against ordinary ActivityPub replay. */
@Entity('gridspace_note_tombstone')
export class MiGridspaceNoteTombstone {
	@PrimaryColumn('varchar', { length: 512 }) public uri: string;
}
