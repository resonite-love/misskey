/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, shallowRef, triggerRef } from 'vue';
import * as Misskey from 'misskey-js';
import type { ComputedRef, Ref, ShallowRef, UnwrapRef } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';

const MAX_ITEMS = 30;
const MAX_QUEUE_ITEMS = 100;
const FIRST_FETCH_LIMIT = 15;
const SECOND_FETCH_LIMIT = 30;

export type MisskeyEntity = {
	id: string;
	createdAt: string;
	_shouldInsertAd_?: boolean;
};

type AbsEndpointType = {
	req: unknown;
	res: unknown;
};

type FilterByEpRes<E extends Record<string, AbsEndpointType>> = {
	[K in keyof E]: E[K]['res'] extends Array<{ id: string }> ? K : never
}[keyof E];
export type PaginatorCompatibleEndpointPaths = FilterByEpRes<Misskey.Endpoints>;
export type PaginatorCompatibleEndpoints = {
	[K in PaginatorCompatibleEndpointPaths]: Misskey.Endpoints[K];
};

export type ExtractorFunction<P extends IPaginator, T> = (item: UnwrapRef<P['items']>[number]) => T;

export interface IPaginator<T = unknown, _T = T & MisskeyEntity> {
	/**
	 * 外部から直接操作しないでください
	 */
	items: Ref<_T[]> | ShallowRef<_T[]>;
	queuedAheadItemsCount: Ref<number>;
	fetching: Ref<boolean>;
	fetchingOlder: Ref<boolean>;
	fetchingNewer: Ref<boolean>;
	canFetchOlder: Ref<boolean>;
	canFetchNewer: Ref<boolean>;
	canSearch: boolean;
	error: Ref<boolean>;
	computedParams: ComputedRef<Misskey.Endpoints[PaginatorCompatibleEndpointPaths]['req'] | null | undefined> | null;
	initialId: MisskeyEntity['id'] | null;
	initialDate: number | null;
	initialDirection: 'newer' | 'older';
	noPaging: boolean;
	searchQuery: Ref<null | string>;
	order: Ref<'newest' | 'oldest'>;

	init(): Promise<void>;
	reload(): Promise<void>;
	fetchOlder(): Promise<void>;
	fetchNewer(options?: { toQueue?: boolean }): Promise<void>;
	trim(trigger?: boolean): void;
	unshiftItems(newItems: (_T)[]): void;
	pushItems(oldItems: (_T)[]): void;
	prepend(item: _T): void;
	enqueue(item: _T): void;
	releaseQueue(): void;
	removeItem(id: string): void;
	updateItem(id: string, updater: (item: _T) => _T): void;
}

export class Paginator<
	Endpoint extends PaginatorCompatibleEndpointPaths,
	E extends PaginatorCompatibleEndpoints[Endpoint] = PaginatorCompatibleEndpoints[Endpoint],
	T extends E['res'][number] & MisskeyEntity = E['res'][number] & MisskeyEntity,
	SRef extends boolean = false,
> implements IPaginator {
	/**
	 * 外部から直接操作しないでください
	 */
	public items: SRef extends true ? ShallowRef<T[]> : Ref<T[]>;

	public queuedAheadItemsCount = ref(0);
	public fetching = ref(true);
	public fetchingOlder = ref(false);
	public fetchingNewer = ref(false);
	public canFetchOlder = ref(false);
	public canFetchNewer = ref(false);
	public canSearch = false;
	public error = ref(false);
	private endpoint: Endpoint;
	private limit: number;
	private params: E['req'] | (() => E['req']);
	public computedParams: ComputedRef<E['req'] | null | undefined> | null;
	public initialId: MisskeyEntity['id'] | null = null;
	public initialDate: number | null = null;

	// 初回読み込み時、initialIdを基準にそれより新しいものを取得するか古いものを取得するか
	// newer: initialIdより新しいものを取得する
	// older: initialIdより古いものを取得する (default)
	public initialDirection: 'newer' | 'older';

	private offsetMode: boolean;
	public noPaging: boolean;
	public searchQuery = ref<null | string>('');
	private searchParamName: keyof E['req'] | 'search';
	private canFetchDetection: 'safe' | 'limit' | null = null;
	private aheadQueue: T[] = [];
	private useShallowRef: SRef;

	private customFilter: ((items: T[]) => T[]) | null = null;

	// 配列内の要素をどのような順序で並べるか
	// newest: 新しいものが先頭 (default)
	// oldest: 古いものが先頭
	// NOTE: このようなプロパティを用意してこっち側で並びを管理せずに、Setで持っておき参照者側が好きに並び変えるような設計の方がすっきりしそうなものの、Vueのレンダリングのたびに並び替え処理が発生することになったりしそうでパフォーマンス上の懸念がある
	public order: Ref<'newest' | 'oldest'>;

	constructor(endpoint: Endpoint, props: {
		limit?: number;
		params?: E['req'] | (() => E['req']);
		computedParams?: ComputedRef<E['req'] | null | undefined>;

		/**
		 * 検索APIのような、ページング不可なエンドポイントを利用する場合
		 * (そのようなAPIをこの関数で使うのは若干矛盾してるけど)
		 */
		noPaging?: boolean;

		offsetMode?: boolean;

		initialId?: MisskeyEntity['id'];
		initialDate?: number | null;
		initialDirection?: 'newer' | 'older';

		order?: 'newest' | 'oldest';

		// 一部のAPIはさらに遡れる場合でもパフォーマンス上の理由でlimit以下の結果を返す場合があり、その場合はsafe、それ以外はlimitにすることを推奨
		canFetchDetection?: 'safe' | 'limit';

		useShallowRef?: SRef;

		canSearch?: boolean;
		searchParamName?: keyof E['req'];

		// resonite.love拡張 API用のカスタムフィルタ
		customFilter?: (items: any[]) => any[];
	}) {
		this.endpoint = endpoint;
		this.useShallowRef = (props.useShallowRef ?? false) as SRef;
		if (this.useShallowRef) {
			this.items = shallowRef<T[]>([]);
		} else {
			this.items = ref<T[]>([]) as Ref<T[]>;
		}

		this.limit = props.limit ?? FIRST_FETCH_LIMIT;
		this.params = props.params ?? {};
		this.computedParams = props.computedParams ?? null;
		this.order = ref(props.order ?? 'newest');
		this.initialId = props.initialId ?? null;
		this.initialDate = props.initialDate ?? null;
		this.initialDirection = props.initialDirection ?? 'older';
		this.canFetchDetection = props.canFetchDetection ?? null;
		this.noPaging = props.noPaging ?? false;
		this.offsetMode = props.offsetMode ?? false;
		this.canSearch = props.canSearch ?? false;
		this.searchParamName = props.searchParamName ?? 'search';

		this.customFilter = props.customFilter ?? null;

		this.getNewestId = this.getNewestId.bind(this);
		this.getOldestId = this.getOldestId.bind(this);
		this.init = this.init.bind(this);
		this.reload = this.reload.bind(this);
		this.fetchOlder = this.fetchOlder.bind(this);
		this.fetchNewer = this.fetchNewer.bind(this);
		this.unshiftItems = this.unshiftItems.bind(this);
		this.pushItems = this.pushItems.bind(this);
		this.prepend = this.prepend.bind(this);
		this.enqueue = this.enqueue.bind(this);
		this.releaseQueue = this.releaseQueue.bind(this);
		this.removeItem = this.removeItem.bind(this);
		this.updateItem = this.updateItem.bind(this);
	}

	private getNewestId(): string | null | undefined {
		// 様々な要因により並び順は保証されないのでソートが必要
		if (this.aheadQueue.length > 0) {
			return this.aheadQueue.map(x => x.id).sort().at(-1);
		}
		return this.items.value.map(x => x.id).sort().at(-1);
	}

	private getOldestId(): string | null | undefined {
		// 様々な要因により並び順は保証されないのでソートが必要
		return this.items.value.map(x => x.id).sort().at(0);
	}

	public async init(): Promise<void> {
		this.items.value = [];
		this.aheadQueue = [];
		this.queuedAheadItemsCount.value = 0;
		this.fetching.value = true;

		const collectedItems: T[] = [];
		let lastId: string | undefined = undefined;
		let lastDate: number | undefined = undefined;
		let totalFetched = 0;
		const maxAttempts = 100; // 最大試行回数

		// 初回のパラメータ設定
		if (this.initialDirection === 'newer') {
			if (this.initialId == null && this.initialDate == null) {
				lastId = '0';
			} else {
				lastId = this.initialId ?? undefined;
				lastDate = this.initialDate ?? undefined;
			}
		} else if ((this.initialId || this.initialDate) && this.initialDirection === 'older') {
			lastId = this.initialId ?? undefined;
			lastDate = this.initialDate ?? undefined;
		}

		// 必要な数のアイテムが集まるまでループ
		while (collectedItems.length < (this.limit ?? FIRST_FETCH_LIMIT) && totalFetched < maxAttempts) {
			const data: E['req'] = {
				...(typeof this.params === 'function' ? this.params() : this.params),
				...(this.computedParams ? this.computedParams.value : {}),
				...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
				limit: this.limit ?? FIRST_FETCH_LIMIT,
				allowPartial: true,
				...(this.initialDirection === 'newer' ? {
					sinceId: lastId,
					sinceDate: lastDate,
				} : lastId || lastDate ? {
					untilId: lastId,
					untilDate: lastDate,
				} : {}),
			};

			let apiRes = (await misskeyApi(this.endpoint, data).catch(err => {
				this.error.value = true;
				this.fetching.value = false;
				return null;
			})) as T[] | null;

			if (apiRes == null) {
				break;
			}

			totalFetched++;

			// APIレスポンスが空の場合、これ以上データがない
			if (apiRes.length === 0) {
				break;
			}

			// 次回のためにIDを更新
			if (this.initialDirection === 'newer') {
				const newest = apiRes[apiRes.length - 1];
				if (newest) lastId = newest.id;
			} else {
				const oldest = apiRes[apiRes.length - 1];
				if (oldest) lastId = oldest.id;
			}

			// resonite.love拡張 API用のカスタムフィルタ
			if (this.customFilter) {
				apiRes = this.customFilter(apiRes);
			}

			// フィルタ後にアイテムがある場合のみ追加
			if (apiRes.length > 0) {
				collectedItems.push(...apiRes);
			}
		}

		// 逆順で返ってくるので
		if ((this.initialId || this.initialDate) && this.initialDirection === 'newer') {
			collectedItems.reverse();
		}

		// 広告挿入位置の設定
		for (let i = 0; i < collectedItems.length; i++) {
			const item = collectedItems[i];
			if (i === 3) item._shouldInsertAd_ = true;
		}

		this.pushItems(collectedItems);

		// canFetch の判定
		if (this.canFetchDetection === 'limit') {
			if (totalFetched >= maxAttempts || collectedItems.length < (this.limit ?? FIRST_FETCH_LIMIT)) {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = false;
			} else {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (totalFetched >= maxAttempts || collectedItems.length === 0 || this.noPaging) {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = false;
			} else {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = true;
			}
		}

		this.error.value = false;
		this.fetching.value = false;
	}

	public reload(): Promise<void> {
		return this.init();
	}

	public async fetchOlder(): Promise<void> {
		if (!this.canFetchOlder.value || this.fetching.value || this.fetchingOlder.value || this.items.value.length === 0) return;
		this.fetchingOlder.value = true;

		const collectedItems: T[] = [];
		let lastId = this.getOldestId();
		let totalFetched = 0;
		const maxAttempts = 100; // 最大試行回数

		// 必要な数のアイテムが集まるまでループ
		while (collectedItems.length < SECOND_FETCH_LIMIT && totalFetched < maxAttempts) {
			const data: E['req'] = {
				...(typeof this.params === 'function' ? this.params() : this.params),
				...(this.computedParams ? this.computedParams.value : {}),
				...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
				limit: SECOND_FETCH_LIMIT,
				...(this.offsetMode ? {
					offset: this.items.value.length + collectedItems.length,
				} : {
					untilId: lastId,
				}),
			};

			let apiRes = (await misskeyApi<T[]>(this.endpoint, data).catch(err => {
				return null;
			})) as T[] | null;

			if (apiRes == null) {
				break;
			}

			totalFetched++;

			// APIレスポンスが空の場合、これ以上データがない
			if (apiRes.length === 0) {
				break;
			}

			// 次回のためにIDを更新（offsetModeでない場合）
			if (!this.offsetMode && apiRes.length > 0) {
				const oldest = apiRes[apiRes.length - 1];
				if (oldest) lastId = oldest.id;
			}

			// resonite.love拡張 API用のカスタムフィルタ
			if (this.customFilter) {
				apiRes = this.customFilter(apiRes);
			}

			// フィルタ後にアイテムがある場合のみ追加
			if (apiRes.length > 0) {
				collectedItems.push(...apiRes);
			}
		}

		this.fetchingOlder.value = false;

		// アイテムが取得できなかった場合は終了
		if (collectedItems.length === 0) {
			this.canFetchOlder.value = false;
			return;
		}

		// 広告挿入位置の設定
		for (let i = 0; i < collectedItems.length; i++) {
			const item = collectedItems[i];
			if (i === 10) item._shouldInsertAd_ = true;
		}

		if (this.order.value === 'oldest') {
			this.unshiftItems(collectedItems.toReversed(), false);
		} else {
			this.pushItems(collectedItems);
		}

		// canFetch の判定
		if (this.canFetchDetection === 'limit') {
			if (totalFetched >= maxAttempts || collectedItems.length < FIRST_FETCH_LIMIT) {
				this.canFetchOlder.value = false;
			} else {
				this.canFetchOlder.value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (totalFetched >= maxAttempts || collectedItems.length === 0) {
				this.canFetchOlder.value = false;
			} else {
				this.canFetchOlder.value = true;
			}
		}
	}

	public async fetchNewer(options: {
		toQueue?: boolean;
	} = {}): Promise<void> {
		this.fetchingNewer.value = true;

		const collectedItems: T[] = [];
		let lastId = this.getNewestId();
		let totalFetched = 0;
		const maxAttempts = 100; // 最大試行回数

		// 必要な数のアイテムが集まるまでループ
		while (collectedItems.length < SECOND_FETCH_LIMIT && totalFetched < maxAttempts) {
			const data: E['req'] = {
				...(typeof this.params === 'function' ? this.params() : this.params),
				...(this.computedParams ? this.computedParams.value : {}),
				...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
				limit: SECOND_FETCH_LIMIT,
				...(this.offsetMode ? {
					offset: this.items.value.length + collectedItems.length,
				} : {
					sinceId: lastId,
				}),
			};

			let apiRes = (await misskeyApi<T[]>(this.endpoint, data).catch(err => {
				return null;
			})) as T[] | null;

			if (apiRes == null) {
				break;
			}

			totalFetched++;

			// APIレスポンスが空の場合、これ以上データがない
			if (apiRes.length === 0) {
				break;
			}

			// 次回のためにIDを更新（offsetModeでない場合）
			if (!this.offsetMode && apiRes.length > 0) {
				const newest = apiRes[apiRes.length - 1];
				if (newest) lastId = newest.id;
			}

			// resonite.love拡張 API用のカスタムフィルタ
			if (this.customFilter) {
				apiRes = this.customFilter(apiRes);
			}

			// フィルタ後にアイテムがある場合のみ追加
			if (apiRes.length > 0) {
				collectedItems.push(...apiRes);
			}
		}

		this.fetchingNewer.value = false;

		// アイテムが取得できなかった場合は終了
		if (collectedItems.length === 0) {
			this.canFetchNewer.value = false;
			return;
		}

		if (options.toQueue) {
			this.aheadQueue.unshift(...collectedItems.toReversed());
			if (this.aheadQueue.length > MAX_QUEUE_ITEMS) {
				this.aheadQueue = this.aheadQueue.slice(0, MAX_QUEUE_ITEMS);
			}
			this.queuedAheadItemsCount.value = this.aheadQueue.length;
		} else {
			if (this.order.value === 'oldest') {
				this.pushItems(collectedItems);
			} else {
				this.unshiftItems(collectedItems.toReversed(), false);
			}
		}

		// canFetch の判定
		if (this.canFetchDetection === 'limit') {
			if (totalFetched >= maxAttempts || collectedItems.length < FIRST_FETCH_LIMIT) {
				this.canFetchNewer.value = false;
			} else {
				this.canFetchNewer.value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (totalFetched >= maxAttempts || collectedItems.length === 0) {
				this.canFetchNewer.value = false;
			} else {
				this.canFetchNewer.value = true;
			}
		}
	}

	public trim(trigger = true): void {
		if (this.items.value.length >= MAX_ITEMS) this.canFetchOlder.value = true;
		this.items.value = this.items.value.slice(0, MAX_ITEMS);
		if (this.useShallowRef && trigger) triggerRef(this.items);
	}

	public unshiftItems(newItems: T[], trim = true): void {
		if (newItems.length === 0) return; // これやらないと余計なre-renderが走る
		this.items.value.unshift(...newItems.filter(x => !this.items.value.some(y => y.id === x.id))); // ストリーミングやポーリングのタイミングによっては重複することがあるため
		if (trim) this.trim(true);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public pushItems(oldItems: T[]): void {
		if (oldItems.length === 0) return; // これやらないと余計なre-renderが走る
		this.items.value.push(...oldItems);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public prepend(item: T): void {
		if (this.items.value.some(x => x.id === item.id)) return;
		this.items.value.unshift(item);
		this.trim(false);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public enqueue(item: T): void {
		this.aheadQueue.unshift(item);
		if (this.aheadQueue.length > MAX_QUEUE_ITEMS) {
			this.aheadQueue.pop();
		}
		this.queuedAheadItemsCount.value = this.aheadQueue.length;
	}

	public releaseQueue(): void {
		if (this.aheadQueue.length === 0) return; // これやらないと余計なre-renderが走る
		this.unshiftItems(this.aheadQueue);
		this.aheadQueue = [];
		this.queuedAheadItemsCount.value = 0;
	}

	public removeItem(id: string): void {
		// TODO: queueからも消す

		const index = this.items.value.findIndex(x => x.id === id);
		if (index !== -1) {
			this.items.value.splice(index, 1);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}

	public updateItem(id: string, updater: (item: T) => T): void {
		// TODO: queueのも更新

		const index = this.items.value.findIndex(x => x.id === id);
		if (index !== -1) {
			const item = this.items.value[index]!;
			this.items.value[index] = updater(item);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}
}
