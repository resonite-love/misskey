/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('gridspace_timeline_outbox')
@Index('UQ_PLACEMENT_EVENT_OUTBOX', ['eventId'], { unique: true })
@Index('IDX_gridspace_timeline_outbox_created', ['createdAt'])
export class MiGridspaceTimelineOutbox {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_gridspace_timeline_outbox' }) public id: string;
	@Column({ type: 'varchar', length: 1024, nullable: true, collation: 'C' }) public canonicalUri: string | null;
	@Column({ ...id(), nullable: true }) public noteId: string | null;
	@Column('varchar', { length: 512, nullable: true }) public channelOrigin: string | null;
	@Column({ ...id(), nullable: true }) public channelId: string | null;
	@Column('bigint', { nullable: true }) public sourceRevision: string | null;
	@Column('bigint', { nullable: true }) public targetRevision: string | null;
	@Column('uuid', { nullable: true }) public eventId: string | null;
	@Column('varchar', { length: 16 }) public kind: string;
	@Column({ ...id(), nullable: true }) public affectedUserId: string | null;
	@Column('timestamp with time zone', { default: () => 'clock_timestamp()' }) public createdAt: Date;
}

@Entity('gridspace_timeline_change')
@Index('UQ_PLACEMENT_EVENT_CHANGE', ['eventId'], { unique: true })
@Index('IDX_gridspace_timeline_change_created', ['createdAt'])
export class MiGridspaceTimelineChange {
	@PrimaryColumn('bigint', { primaryKeyConstraintName: 'PK_gridspace_timeline_change' }) public sequence: string;
	@Column({ type: 'varchar', length: 1024, nullable: true, collation: 'C' }) public canonicalUri: string | null;
	@Column({ ...id(), nullable: true }) public noteId: string | null;
	@Column('varchar', { length: 512, nullable: true }) public channelOrigin: string | null;
	@Column({ ...id(), nullable: true }) public channelId: string | null;
	@Column('bigint', { nullable: true }) public sourceRevision: string | null;
	@Column('bigint', { nullable: true }) public targetRevision: string | null;
	@Column('uuid', { nullable: true }) public eventId: string | null;
	@Column('varchar', { length: 16 }) public kind: string;
	@Column({ ...id(), nullable: true }) public affectedUserId: string | null;
	@Column('timestamp with time zone') public createdAt: Date;
}

@Entity('gridspace_timeline_state')
export class MiGridspaceTimelineState {
	@PrimaryColumn('varchar', { length: 32, primaryKeyConstraintName: 'PK_gridspace_timeline_state' }) public key: string;
	@Column('integer', { default: 1 }) public generation: number;
	@Column('bigint', { default: 0 }) public nextSequence: string;
	@Column('bigint', { default: 0 }) public trimmedThrough: string;
}
