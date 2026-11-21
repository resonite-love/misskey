/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiChannel } from './Channel.js';
import { MiNote } from './Note.js';

@Entity('note_channel_placement')
@Index('UQ_LOCAL_PLACEMENT_NOTE_CHANNEL', ['noteId', 'channelId'], { unique: true })
@Index('UQ_LOCAL_PLACEMENT_CHANNEL_URI', ['channelId', 'canonicalUri'], { unique: true })
@Index('IDX_LOCAL_PLACEMENT_ORDER', ['channelId', 'sortAt', 'canonicalUri'], { where: "state = 'active'" })
export class MiNoteChannelPlacement {
	@PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_LOCAL_PLACEMENT' })
	public id: string;

	@Column({ ...id(), nullable: true })
	public noteId: string | null;

	@ManyToOne(() => MiNote, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'noteId', foreignKeyConstraintName: 'FK_LOCAL_PLACEMENT_NOTE' })
	public note: MiNote | null;

	@Column(id())
	public channelId: string;

	@ManyToOne(() => MiChannel, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'channelId', foreignKeyConstraintName: 'FK_LOCAL_PLACEMENT_CHANNEL' })
	public channel: MiChannel;

	@Column({ type: 'varchar', length: 512, collation: 'C' })
	public canonicalUri: string;

	@Column('timestamptz')
	public sortAt: Date;

	@Column('varchar', { length: 32 })
	public state: 'active' | 'removed' | 'origin-deleted';

	@Column('timestamptz', { nullable: true })
	public removedAt: Date | null;

	@Column({ ...id(), nullable: true })
	public removedBy: string | null;
}

@Entity('note_create_receipt')
@Index('IDX_CREATE_RECEIPT_NOTE', ['noteId'])
export class MiNoteCreateReceipt {
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_NOTE_CREATE_RECEIPT' })
	public userId: string;

	@PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_NOTE_CREATE_RECEIPT' })
	public clientRequestId: string;

	@Column('varchar', { length: 64 })
	public inputHash: string;

	@Column('varchar', { length: 512 })
	public canonicalUri: string;

	@Column({ ...id(), nullable: true })
	public noteId: string | null;

	@ManyToOne(() => MiNote, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'noteId', foreignKeyConstraintName: 'FK_CREATE_RECEIPT_NOTE' })
	public note: MiNote | null;

	@Column('boolean', { default: false })
	public deleted: boolean;
}

@Entity('channel_placement_pin')
export class MiChannelPlacementPin {
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_CHANNEL_PLACEMENT_PIN' })
	public channelId: string;

	@ManyToOne(() => MiChannel, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'channelId', foreignKeyConstraintName: 'FK_CHANNEL_PLACEMENT_PIN' })
	public channel: MiChannel;

	@PrimaryColumn('varchar', { length: 512, collation: 'C', primaryKeyConstraintName: 'PK_CHANNEL_PLACEMENT_PIN' })
	public canonicalUri: string;

	@Column('integer')
	public rank: number;
}

@Entity('note_create_dispatch')
@Index('IDX_NOTE_DISPATCH_RETRY', ['retryAt'])
export class MiNoteCreateDispatch {
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_NOTE_CREATE_DISPATCH' })
	public noteId: string;

	@ManyToOne(() => MiNote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'noteId', foreignKeyConstraintName: 'FK_NOTE_CREATE_DISPATCH' })
	public note: MiNote;

	@Column('timestamptz')
	public retryAt: Date;

	@Column('integer', { default: 0 })
	public attempts: number;

	@Column('boolean', { default: false })
	public silent: boolean;
}
