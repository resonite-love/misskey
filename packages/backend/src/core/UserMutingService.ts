/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, LessThan } from 'typeorm';
import type { MutingsRepository, MiMuting } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import type { MiUser } from '@/models/User.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { CacheService } from '@/core/CacheService.js';

@Injectable()
export class UserMutingService {
	constructor(
		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		private idService: IdService,
		private cacheService: CacheService,
	) {
	}

	@bindThis
	public async mute(user: MiUser, target: MiUser, expiresAt: Date | null = null): Promise<void> {
		await this.mutingsRepository.insert({
			id: this.idService.gen(),
			expiresAt: expiresAt ?? null,
			muterId: user.id,
			muteeId: target.id,
		});

		this.cacheService.userMutingsCache.refresh(user.id);
	}

	@bindThis
	public async extendMute(userId: string, targetId: string, expiresAt: Date | null): Promise<boolean> {
		await this.mutingsRepository.createQueryBuilder().update()
			.set({ expiresAt })
			.where('"muterId" = :userId AND "muteeId" = :targetId', { userId, targetId })
			.andWhere('"expiresAt" IS NOT NULL AND (CAST(:expiry AS timestamptz) IS NULL OR "expiresAt" < CAST(:expiry AS timestamptz))', { expiry: expiresAt?.toISOString() ?? null })
			.execute();
		this.cacheService.userMutingsCache.refresh(userId);
		return this.mutingsRepository.existsBy({ muterId: userId, muteeId: targetId });
	}

	@bindThis
	public async unmute(mutings: MiMuting[], expiredOnly = false): Promise<void> {
		if (mutings.length === 0) return;

		await this.mutingsRepository.delete({
			id: In(mutings.map(m => m.id)),
			...(expiredOnly ? { expiresAt: LessThan(new Date()) } : {}),
		});

		const muterIds = [...new Set(mutings.map(m => m.muterId))];
		for (const muterId of muterIds) {
			this.cacheService.userMutingsCache.refresh(muterId);
		}
	}
}
