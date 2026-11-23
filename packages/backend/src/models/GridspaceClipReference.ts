/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { MiClip } from './Clip.js';

/** Membership only. The original server remains responsible for body access. */
@Entity('gridspace_clip_reference')
@Index('IDX_gridspace_clip_reference_uri', ['clipId', 'canonicalUri'], { unique: true })
@Index('IDX_gridspace_clip_reference_order', ['clipId', 'sortAt', 'noteId'])
export class MiGridspaceClipReference {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_gridspace_clip_reference' }) public id: string;
	@Column('varchar', { length: 32 }) public clipId: string;
	@ManyToOne(() => MiClip, { onDelete: 'CASCADE' })
	@JoinColumn({ foreignKeyConstraintName: 'FK_gridspace_clip_reference_clip' }) public clip: MiClip;
	@Column({ type: 'varchar', length: 512, collation: 'C' }) public canonicalUri: string;
	@Column('varchar', { length: 32 }) public noteId: string;
	@Column('timestamp with time zone') public sortAt: Date;
}
