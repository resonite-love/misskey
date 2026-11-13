/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('gridspace_drive_entry')
@Index('IDX_gridspace_drive_source', ['linkId', 'kind', 'origin', 'sourceId'], { unique: true })
@Index('IDX_gridspace_drive_local', ['kind', 'localId'], { unique: true })
@Index('IDX_gridspace_drive_pending', ['pending', 'retryAt'])
export class MiGridspaceDriveEntry {
	@PrimaryColumn('uuid') public id: string;
	@Column('uuid') public linkId: string;
	@Column('varchar', { length: 8 }) public kind: 'file' | 'folder';
	@Column('varchar', { length: 512 }) public origin: string;
	@Column(id()) public sourceId: string;
	@Column(id()) public localId: string;
	@Column('integer', { default: 0 }) public revision: number;
	@Column('boolean', { default: false }) public deleted: boolean;
	@Column('boolean', { default: false }) public pending: boolean;
	@Column('timestamp', { default: () => 'CURRENT_TIMESTAMP' }) public retryAt: Date;
	@Column('integer', { default: 0 }) public attempts: number;
	@Column('varchar', { length: 64, nullable: true }) public lastError: string | null;
	@Column('jsonb', { nullable: true }) public payload: Record<string, unknown> | null;
}
