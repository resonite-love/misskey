/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('gridspace_channel_placement')
@Index('IDX_gridspace_channel_placement_1', ['channelId', 'canonicalUri'], { unique: true })
@Index('IDX_gridspace_channel_placement_2', ['channelId', 'sortAt', 'canonicalUri'], { where: "state = 'active'" })
@Index('IDX_gridspace_channel_placement_3', ['retryAt'])
@Index('IDX_gridspace_mirror_placements', ['canonicalUri', 'channelId'], { where: 'state = \'active\' AND "includeDefault"' })
export class MiGridspacePlacement {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_gridspace_channel_placement' }) public id: string;
	@Column('varchar', { length: 32 }) public channelId: string;
	@Column({ type: 'varchar', length: 512, collation: 'C' }) public canonicalUri: string;
	@Column('integer') public sourceRevision: number;
	@Column('integer') public targetRevision: number;
	@Column('timestamp with time zone') public sortAt: Date;
	@Column('varchar', { length: 20 }) public state: 'active' | 'removed' | 'origin-deleted';
	@Column('uuid') public version: string;
	@Column('integer') public attempts: number;
	@Column('timestamp with time zone', { nullable: true }) public retryAt: Date | null;
	@Column('varchar', { length: 512 }) public noteOrigin: string;
	@Column('varchar', { length: 512 }) public channelOrigin: string;
	@Column('varchar', { length: 32 }) public originNoteId: string;
	@Column('varchar', { length: 512 }) public authorUri: string;
	@Column('varchar', { length: 512 }) public authorOrigin: string;
	@Column('boolean') public includeDefault: boolean;
}

@Entity('gridspace_placement_target')
@Index('IDX_gridspace_placement_target_1', ['canonicalUri', 'peerOrigin', 'channelId'], { unique: true })
@Index('IDX_gridspace_placement_target_2', ['noteId'])
@Index('IDX_gridspace_placement_target_3', ['retryAt'])
export class MiGridspacePlacementTarget {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_gridspace_placement_target' }) public id: string;
	@Column('varchar', { length: 32 }) public channelId: string;
	@Column({ type: 'varchar', length: 512, collation: 'C' }) public canonicalUri: string;
	@Column('integer') public sourceRevision: number;
	@Column('integer') public targetRevision: number;
	@Column('timestamp with time zone') public sortAt: Date;
	@Column('varchar', { length: 20 }) public state: 'active' | 'pending' | 'failed' | 'removed' | 'origin-deleted';
	@Column('uuid') public version: string;
	@Column('integer') public attempts: number;
	@Column('timestamp with time zone', { nullable: true }) public retryAt: Date | null;
	@Column('varchar', { length: 32 }) public noteId: string;
	@Column('boolean', { default: false }) public permanentFailure: boolean;
	@Column('varchar', { length: 512 }) public peerOrigin: string;
	@Column('varchar', { length: 32 }) public authorId: string;
	@Column('boolean') public includeDefault: boolean;
	@Column('varchar', { length: 128 }) public name: string;
	@Column('varchar', { length: 16 }) public color: string;
	@Column('uuid', { nullable: true }) public placementId: string | null;
}
