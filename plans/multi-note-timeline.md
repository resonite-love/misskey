# Multi Note：タイムライン・検索の実装計画

- 調査日: 2026-11-21
- 対象: れぞらぶ / ぐりすぺ `feat/multi-note`
- 状態: 実装・検証後の要件更新を反映した。本文は当初の調査案を含む。最新の実装状況と未対応差分は、ぐりすぺ側の掲載契約案・検証記録を参照する。
- レビュー結果: [multi-note-claude-review.md](multi-note-claude-review.md)。
- 製品仕様とUI: [multi-note.md](multi-note.md)。サーバー間連携: ぐりすぺ側 `plans/multi-note-peer.md`。
- 最新化後の調査基点: れぞらぶ `57ee8ed337`、ぐりすぺ `9a15160548` の `codex/gridspace-bridge`。計画用ブランチはまだ旧基点なので、実装開始前に基点をそろえる。

## 今回必須と後回し（2026-11-21）

今回必須はincludeDefaultと掲載表、通常TL/RSS/連合/共有への混入防止、既存の閲覧制限と用途別書込権限、個別削除・退会・再送、両方向の返信/反応/投票、一覧統合と作成キーの復旧。公開本文URL・添付の完全失効、未掲載の本人限定化、全既存履歴の返信修復、通常AP投票全体の排他再設計、全匿名閲覧の掲載証明は後回しにする。新規データの会話破損・操作不能・二重加算は今回防ぐ。

掲載解除後も原本URL・標準API・会話は既存の公開条件で読める。既存のブロック・停止・サインイン要求・非表示時刻は維持する。hasVisibleRouteは一覧に載せる経路を判定するもので、直接URLの閲覧権を掲載状態で失効させる判定には使わない。詳細なM1〜M8/D1〜D5と受け入れ条件は、ぐりすぺ側の掲載契約案を正とする。

Multi Noteの予約投稿と投稿後の掲載先追加・再追加は要件から除外する。公開センシティブチャンネルは掲載対象に含め、必要なCWは投稿者が付けた原本の値を共用する。センシティブ属性だけを理由に候補・作成・peer掲載・チップ表示から一律除外しない。一律除外は両リポジトリで撤去し、明示したチャンネルの一覧・ピンを検証済み。統合プロフィールにも既存の掲載条件を適用し、閲覧フィルターやモデレーションの条件を維持する。

## 最新版の統合タイムラインに合わせた追加（2026-11-21）

最新版には原本URIを使う統合タイムライン、delegated本文の再認可、表示更新用のDB outboxが既にある。以下の初期調査で挙げた通常API・Redis・ストリームの互換対応に加え、`core/gridspace/timeline/` と既存の権限付き取得を拡張する。表示更新用outboxの新規作成を前提にせず、掲載配送に必要な永続記録とは分ける。

`TimelineLocalSource` の通常投稿先・フォローチャンネル判定、`GridspacePrivateService` のpeer候補取得、`GridspaceTimelineService.localSource` のチャンネルをpeer側のみとする分岐、`TimelineReferenceService` のローカルnote行を起点とする参照を変更対象に加える。`TimelineMergeService` の `canonicalUri` 重複除去は使えるが、閲覧可能な掲載先の集約と、本文を取りに行くサーバーの選択は追加が必要。

相手原本の掲載にはローカルnote行がない場合がある。channelOrigin/channelIdとnoteOrigin/originNoteIdを分け、一覧/本文がlocal/peerとなる4通りを扱う。原本の識別はURIで固定するが、通常系のlocalミラー優先の表示・操作は維持する。ホームは経路の和集合を保つ。掲載変更はnote IDなしでもURI必須のイベントとして追跡する。新一覧は原本時刻＋URIのカーソルで版を分け、旧APIは実在行の部分集合を返す。参照、用途別書込証明、削除記録、永続配送、集計・ピンは掲載契約案に従う。

## 結論

原本のノートは1件とし、「通常の投稿先に含めるか」と「掲載するチャンネル」を別々に保存する。チャンネルだけの投稿、通常＋チャンネル、複数チャンネルへの投稿を同じ仕組みで扱う。チャンネル数に製品上の固定上限は置かない。

タイムラインの変更は表示部品だけでは済まない。現在の DB 取得、Redis fanout、WebSocket、検索、プロフィール、ランキングは `note.channelId` が1件である前提を持つ。新規の複数掲載ノートで `channelId = null` を使うと、チャンネルだけの投稿が通常タイムラインへ入り、チャンネル一覧とストリームには出なくなる。作成時の分岐と全読取経路を同じ掲載先判定にそろえる。

2026-11-21の方針は通常投稿先の有無を共通処理に集約し、取得先の指定を必須にすること。旧投稿の解釈は共通の互換処理に集める。以下の修正と結合テストが済むまで、新方式の投稿は有効にしない。

ActivityPubのJSON形式は変えない。通常投稿先がありlocalOnly=falseの原本のみ既存のCreate/Deleteの対象とし、掲載情報をAPへ載せない。NoteCreateServiceの配送条件とAPのnote/activity/outboxの回帰確認は必須。Webの原本URLが既存公開条件で読めることと、AP自動配送を止めることは分ける。

## 現行コードで確かめたこと

| 経路 | 現行の判定・処理 | 変更の要点 |
| --- | --- | --- |
| 保存 | `models/Note.ts` の `channelId` は単数。`NoteCreateService.insertNote` は必要時だけDBトランザクションを使う | 新方式の投稿は常に原本・掲載・冪等記録を同一トランザクションにする |
| 作成 | `NoteCreateService` はチャンネル投稿の `visibility=public`、`localOnly=true` を強制。`gridspaceShared` も `channelId` で判定 | 通常投稿先がない場合だけ `localOnly=true` を強制。通常共有も通常投稿先の有無を見る |
| Redis書込 | `pushToTl` は `channelId` の有無でチャンネル経路と通常経路を二分 | 通常経路とチャンネル経路を独立に処理し、同じ `(timeline key, note ID)` は1回だけ追加 |
| Redis読取 | `FanoutTimelineEndpointService` は複数リストのIDを `Set` で重複除去。ただし通常経路の `noteFilter` は投稿先を全面検証しない | Redis IDのDB再取得時にも投稿先を確認。DB fallbackとの境界も重複を確認 |
| DB読取 | `channels/timeline` は `channelId = ...`。LTL/GTL/ユーザー一覧は `channelId IS NULL`。HTL/ハイブリッドは両方を組み合わせる | 通常投稿先の共通判定に置換。単一チャンネルは掲載表の索引から取得し、複数掲載の照会では行の重複を防ぐ |
| WebSocket | `notesStream` は原本を1回発行。各ストリームが packed note の単一 `channelId` で振り分ける | packed note に掲載先を付け、接続ごとに到達経路を1回判定 |
| ミュート | `isChannelRelated` は本人・Renote先の単一 `channelId` を確認 | ミュートされた掲載経路だけ除外。通常経路または別の未ミュートチャンネルがあれば表示 |
| 検索 | `SearchService` のSQL検索とMeilisearch索引・フィルタは単一 `channelId` | 両プロバイダーで通常/チャンネル絞り込みをそろえ、チャンネル専用原本の意図しない露出を防ぐ |
| 付随処理 | `users/notes`、`roles/notes`、`antennas/notes`、featured、`Poll.channelId`、チャンネル集計に単一チャンネル前提 | 推薦・一覧の取得条件も修正し、集計は掲載先ごとに一度更新する |

## 保存形式と互換性

`note.includeDefault` を nullable boolean で追加する。移行中の正規の判定は次のとおり。

```text
通常投稿先あり := includeDefault = true
             OR (includeDefault IS NULL AND channelId IS NULL)
通常投稿先なし := includeDefault = false
             OR (includeDefault IS NULL AND channelId IS NOT NULL)
チャンネル C に掲載 := 有効な note_channel_placement(noteId, C)
                 OR (旧 channelId = C かつ当該掲載の解除記録がない)
```

`NULL` は移行前の既存行の互換値に限る。更新後の `NoteCreateService.insertNote` は、旧クライアント、連合受信、ぐりすぺ返信、予約投稿を含む全作成経路で true / false を明示する。旧 `channelId` だけの作成要求でも初日から掲載表へ同時に書く。新方式のノートは `channelId=null`、掲載先は `note_channel_placement` に置く。既存行のフラグと掲載表は、migrationの外でID範囲ごとの再開可能なバッチにより埋める。掲載行の追加は `ON CONFLICT DO NOTHING` とし、解除済み状態を上書きしない。旧版の書込プロセスを停止し、全作成経路の更新と件数照合が済んでから、互換値と旧列の併読を廃止する工程へ進む。

掲載表は `noteId`、`channelId`、`canonicalUri`、`sortAt`、`state` (`active` / `removed`)、`createdAt`、解除時刻・解除主体を持つ。`(noteId, channelId)` と `(channelId, canonicalUri)` を一意にする。原本削除時は状態を更新し、noteIdの外部キーはSET NULLで最小記録を保持する。解除状態と原本URIの削除記録は初期版では期限なしとし、本文・tokenを残さない。旧掲載の解除時はremoved行をupsertし、旧列の併読で復活させない。投稿後の後付け・再追加は要件に含めない。

段階1は有効掲載の `(channelId, noteId DESC)` 索引で既存順序を維持する。段階2の新しい統合一覧では `(channelId, sortAt DESC, canonicalUri DESC)` の有効掲載用索引を使い、URIはC照合にそろえる。sortAtは既存IdServiceで原本IDの時刻を求め、canonical URIは既存のURI生成で保存・バックフィルする。相手の掲載と同じキーで取得する。

新規migrationには `up` / `down` を設ける。大規模表の索引・バックフィルはロック時間を確認し、並行作成が必要な索引は既存migrationの方式に従う。旧 `channelId` と新掲載表を両方読める期間を設け、件数照合後に旧経路の整理を検討する。機能停止時は新ノートを旧クライアントが安全に表示できないため、単純なスキーマ `down` をロールバック手段にしない。

## 投稿と公開の不変条件

新APIでは `includeDefault` と `channelIds[]` を受ける。空の投稿先、重複ID、旧 `channelId` との混在、存在しない・アーカイブ済み・書込不可のチャンネルを原本作成前に拒否する。チャンネルを選んだ場合は `visibility=public` を要求し、他の公開範囲を自動で広げない。公開センシティブチャンネルはセンシティブ属性だけで選択不可にせず、投稿者が設定したCWを共用する。非公開・メンバー限定などの新しい閲覧権限モデルは対象外とする。返信・引用・Renoteとの複数掲載も初期版では作成前に拒否する。

`NoteCreateService` は通常投稿に含まれるセンシティブ語や `canPublicNote=false` の権限で `public` を `home` に下げる。新方式の投稿先にチャンネルがある場合は、この判定後も `public` を満たすか確認し、不一致なら投稿全体を作成前に拒否して理由を返す。自動的にチャンネル掲載だけを取り消したり、公開範囲を変えたまま投稿したりしない。

`includeDefault=false` なら `localOnly=true`、`gridspaceShared=false` をサーバーで確定する。`includeDefault=true` なら利用者の連合設定を維持する。`channelIds` の件数に固定の製品上限は設けず、既存のリクエストサイズ・投稿頻度制限を適用する。投稿先数に比例するDB・Redis処理は分割し、処理量と失敗率を計測する。タイムアウト後の再送で原本が増えないよう、投稿者と冪等キーの組に一意制約を持たせ、同一内容の再送は最初の結果を返す。

作成サービスによる確定に加え、`includeDefault=false` と `localOnly=false` の組合せを拒否するDB CHECK制約を設ける。ぐりすぺでは `gridspaceShared=true` との不整合も防ぐ。この制約は一覧の掲載先判定を代替しないため、通常タイムライン・推薦・共有経路の修正も必須とする。

### 共通会話への返信

専用原本・返信のnotes/show・children・conversation・SSR・入れ子・公開リンク・添付は既存の公開条件で扱う。本文の直接閲覧に掲載証明を必須化しない。Query/NoteEntity/shouldHideNoteとskipHideからの送信先は、配信先の分離と既存閲覧制限の維持に必要な範囲だけ変更する。返信・アップロードには閲覧と区別した書込許可を検査し、アーカイブ/解除後に書込可能な経路がない専用会話は返信を拒否する。

新方式の原本への返信は、親の掲載先を複製せず、同じ `replyId` の会話へ1件だけ追加する。通常＋チャンネルの親への返信は既存の通常返信ルールに従い、親がチャンネル専用なら返信も `includeDefault=false`、`localOnly=true` の「会話内のみ」とする案を維持する。この場合だけ、返信に投稿先0件を許す。`notes/children` と投稿詳細で表示し、通常・チャンネルの一覧、通常検索、`withChannelNotes=true` のプロフィールにも独立した行を追加しない。親の閲覧条件と返信者の権限を確認する。旧単一チャンネルノートへの返信は従来のチャンネル継承を維持する。返信のフラグ確定はエンドポイント任せにせず `NoteCreateService.create()` 内で行い、旧クライアント・予約投稿・ぐりすぺ返信からも同じ条件を適用する。

段階2の相手原本への返信も既存保存方式に寄せる。通常投稿先を含む親は返信者側に通常ミラーを確保し、ローカルreplyIdから既存のthreadId・children・AP inReplyToを生成する。親取得の失敗をルート投稿へ変換しない。チャンネル専用の返信・子孫は会話ルートの原本側に置き、既存peerReplyのguest actor・receipt・添付を拡張する。noteOriginとauthorOriginは異なり得る。URIだけの親参照・分散返信索引は作らない。

リアクションは通常系で行為者ホームの集合とrevision同期、専用系で原本側集約を維持する。分類は通常投稿先・来歴・会話ルートで行い、ExtendedReactionServiceの追加/解除にも渡す。通常の連合投票は既存経路、ペア内localOnlyと専用投票は原本側の署名付き処理へ振り分け、票数・本人選択を反映する。既存AP投票全体の排他再設計は後回し。guest通知は限定取得を拡張し、通知IDで重複除去する。linkedの別actorは統合せず、既存閲覧条件を維持する。

通常系の表示・myReaction・操作IDは閲覧側の実在ミラーへそろえ、取込み前は操作不可とする。専用返信の本人削除は親や掲載の存続を要求せず、来歴と投稿者URIを原本側で検査する新delete-replyを使う。添付はActionServiceのuploadSource/lockUpload/peerUploadを会話ルート文脈へ拡張する。

既存クライアントは `channelId=null` の新方式の原本を通常投稿と誤認し得る。チャンネル専用原本と会話内の返信のローカル引用・Renoteは初期版で拒否する案とし、通常＋チャンネルの原本を一律拒否する従来案は取り下げる。連合受信の Announce と引用も `NoteCreateService` を通るため、通常投稿として連合した原本の受信を壊さないことを必須条件とする。ローカル操作の拒否範囲と掲載先の `allowRenoteToExternal` の扱いは書込有効化前に確定し、対応クライアントに理由を表示する。

## 読取判定

共通の掲載先サービスに、DB用の条件と、Redis再取得・packed note用の判定をまとめる。通常投稿先の有無を知るために各エンドポイントへ `channelId IS NULL` を直接書かず、旧投稿の互換条件もこのサービス内に集約する。判定は次の3つを区別する。

1. `includesDefault(note)`：通常投稿先があるか。
2. `activePlacements(note)`：掲載中のチャンネルID集合。旧単一チャンネルも含む。
3. `hasVisibleRoute(note, viewer, timeline)`：その一覧へ通常経路、未ミュートのフォローチャンネル、対象チャンネルのどれで掲載できるか。原本URLの閲覧可否とは分ける。

取得処理には通常タイムライン、ホーム、対象チャンネル、プロフィール、検索、推薦などの文脈を明示する必須引数を設ける。文脈を省略して全件許可する既定値は置かず、型チェックと実行時検証で指定忘れを検出する。Redisの本人投稿を無条件に通す既存オプションも、掲載先の条件を迂回しないようにする。

`hasVisibleRoute` は既存の visibility、ブロック、ユーザーミュート、返信表示設定、センシティブ設定と組み合わせ、どちらかの条件を満たさなければ表示しない。チャンネルミュートは掲載経路に作用し、通常投稿先のある原本を丸ごと消さない。チャンネル画面 C では C の掲載が有効なら表示し、他チャンネルのミュートだけを理由に消さない。Renote対象のチャンネルミュートは既存の `isChannelRelated` と `renoteChannelId` の扱いを整理し、既存Renoteの挙動も確認する。

| 取得先 | 判定 |
| --- | --- |
| チャンネル C | C の有効掲載。旧 `channelId=C` を併読。1ノート1行。 |
| ホーム | `(通常投稿先あり AND 投稿者をフォロー/本人) OR フォロー中で未ミュートの掲載先あり`。返信設定と公開範囲を既存どおり追加。 |
| ローカル / グローバル / リレー | 通常投稿先あり。既存のローカル性・公開範囲・連合条件も追加。 |
| ハイブリッド | `(通常投稿先あり AND 自分/フォロー中/ローカル公開) OR フォロー中で未ミュートの掲載先あり`。括弧を保つ。 |
| ユーザー一覧 | 通常投稿先あり。 |
| プロフィール | `withChannelNotes=false` は通常投稿先のみ。true は通常経路または閲覧できる掲載先。 |

単一チャンネルのDB取得は掲載表の索引を起点にし、ノートID順でページングする。一意な `(noteId, channelId)` の1チャンネル分をJOINする場合は行が増えない。複数チャンネルを扱うホームでは `EXISTS` と通常経路・掲載経路を別々に絞って統合するクエリを比較し、実装時に実行計画で選ぶ。閲覧権などの追加フィルタ後も件数とカーソルが正しくなるよう、候補の補充を含めて検証する。現行の `note.channelId NOT IN (...)` はNULLの新形式を落とすため、掲載先ごとのミュート条件へ切り替える。

`FanoutTimelineEndpointService` のRedis再取得時には掲載表もバッチで読み、DB取得と同じ判定を適用する。キャッシュに古いIDが残っても掲載解除後は表示しない。RedisとDB fallbackを連結する箇所でもIDを重複除去してから件数を満たす。`sinceId` / `untilId`、`withFiles`、返信あり/なし、複数リストの結合を個別に試す。

### アンケート推薦

現在の `notes/polls/recommendation` は `excludeChannels=false` が既定値で、チャンネル投稿も含められる。問題は `excludeChannels=true` の除外条件が、原本から複製した `poll.channelId IS NULL` だけを見ていること。新方式では `poll.note` をJOINまたは `noteId` で参照し、通常投稿先の共通判定を適用する。新たな投稿先フラグを `poll` へ複製しない。判定は `LIMIT/OFFSET` の前に行い、推薦候補の件数とページが崩れないようにする。

`excludeChannels=true` では通常のみ・通常＋チャンネルを含め、旧単一チャンネル・新しいチャンネル専用原本を除く。falseでは既存のチャンネル込み推薦の仕様を維持し、チャンネル専用という理由だけで一律除外しない。会話内だけの返信は両方の推薦から除く案とし、返信仕様の確定時に合わせて検証する。

## 書込fanoutとストリーム

`NoteCreateService.pushToTl` を「通常投稿先のfanout」と「各チャンネルへのfanout」に分ける。チャンネル一覧には選択した各チャンネルへ1回ずつ追加する。ホームは投稿者フォロワー、各チャンネルのフォロワー、本人の和集合を取る。`homeTimelineWithFiles` を含むRedisキーごとに `Set<noteId>` で同一投稿の重複 `LPUSH` を防ぐ。`userTimelineWithChannel` と通常の `userTimeline` は用途に応じて両方へ入れ、読み取り側ではノートIDを1行にする。大量フォロワーへのRedis pipelineは既存の分割方針に従う。

現行の作成後処理は `setImmediate` で動くため、DBコミット後のプロセス停止でfanout・集計・索引更新が欠け得る。新方式では原本・掲載・冪等記録・後続処理のジョブ記録を同一DBトランザクションで保存し、コミット後に永続ジョブから実行する。冪等キーの再送は最初の投稿結果を返し、ジョブは投稿ID・掲載先・処理種別で再実行しても件数や通知を二重加算しない。Redis追加とジョブ完了の間で停止した場合の重複も検証対象にする。

WebSocketは原本につき `notesStream` を1回だけ発行し、packed note の `includeDefault` と `channelPlacements` を使って各接続の表示先を決める。`channelPlacements` は `NoteEntityService.packMany` で一覧ノート分をまとめて読み、返信・Renoteの入れ子も考慮して N+1 を避ける。`channel` / `channelId` は旧単一チャンネルの互換フィールドとして残す。`models/json-schema/note.ts` と misskey-js の型を更新する。ストリーム送信前に閲覧権とミュートを再確認し、同じ接続の同じタイムラインへ同じ原本を二重送信しない。

確認対象は `home-timeline`、`hybrid-timeline`、`local-timeline`、`global-timeline`、`channel`、`user-list`、vmimi relay の各ストリーム。ぐりすぺ側は連携アカウントの `linkedUserId` をホーム/ハイブリッドの通常経路に加える独自処理がある。`gridspaceShared` によるローカルタイムラインへのリモート原本表示も維持するが、チャンネル専用原本をこの経路へ通さない。

## 検索・集計・周辺機能

`SearchService` のSQL経路はチャンネル指定時に有効掲載で絞る。Meilisearchの文書は原本IDを一意キーとし、`includeDefault` と有効 `channelIds[]` を索引に持つ。チャンネル指定の検索では配列フィルタを使う。現行の通常検索は旧チャンネル投稿を一律には除外しないため、新方式だけを除外する案は未確定とし、通常タイムラインの条件を検索へ無条件に流用しない。検索範囲を明示する共通処理で旧投稿と新投稿を同じ方針にそろえる。Meilisearchの結果をDBから再取得する際も最新の掲載状態と閲覧権を確認する。掲載解除・原本削除・索引再構築で古い検索結果を残さない。フィルタ設定追加と再索引の完了確認を配備工程に含める。

`FeaturedService`、`notes/featured`、チャンネルの `notesCount` / `usersCount` / `lastNotedAt` は、同一原本をチャンネルごとに一度だけ数える。通常ランキングには通常投稿先がある原本だけを入れる。`usersCount` は投稿者とチャンネルの一意組で数え、掲載解除で再計算する。アンテナ、通知、Webhook、プラグインイベント、`users/notes`、`polls/recommendation`、引用メニューも単一 `channelId` 前提を監査する。アンテナや通知は同じ原本について受信者ごとに1件とする。

`roles/notes` と `antennas/notes` は通常タイムライン専用と決めつけず、それぞれのチャンネル掲載・ミュート仕様に沿って共通判定へ移す。`ReactionService` のランキング更新、`channels/update` とノートメニューのピン留め、「削除して編集」の投稿先復元も変更対象に加える。ピン留めは対象チャンネルで有効掲載中かサーバーで検証し、掲載解除時はそのチャンネルのピンだけを外す。

## 主な変更対象ファイル

| 作業 | れぞらぶの対象 |
| --- | --- |
| DB・移行 | `packages/backend/src/models/Note.ts`、新しい掲載entity・ジョブ記録・掲載先サービス、`packages/backend/migration/`、DI・entity登録箇所、再開可能なバックフィル |
| 投稿・削除・集計 | `packages/backend/src/server/api/endpoints/notes/create.ts`、`packages/backend/src/core/NoteCreateService.ts`、`NoteDeleteService.ts`、`ReactionService.ts`、`FeaturedService.ts`、`AntennaService.ts` |
| DB/Redis一覧 | `packages/backend/src/core/QueryService.ts`、`FanoutTimelineEndpointService.ts`、`FanoutTimelineService.ts`、`packages/backend/src/server/api/endpoints/channels/timeline.ts`、`notes/{timeline,local-timeline,global-timeline,hybrid-timeline,user-list-timeline,vmimi-relay-timeline,vmimi-relay-hybrid-timeline}.ts`、`users/notes.ts`、`roles/notes.ts`、`antennas/notes.ts` |
| アンケート推薦 | `packages/backend/src/server/api/endpoints/notes/polls/recommendation.ts`、`packages/backend/src/models/Poll.ts` の現行非正規化列の利用箇所。新しい判定は `note` を参照 |
| ストリームとミュート | `packages/backend/src/server/api/stream/channels/{home-timeline,local-timeline,global-timeline,hybrid-timeline,channel,user-list,vmimi-relay-timeline,vmimi-relay-hybrid-timeline}.ts`、`stream/channel.ts`、`packages/backend/src/misc/is-channel-related.ts` |
| 検索・ノート形式 | `packages/backend/src/core/SearchService.ts`、`entities/NoteEntityService.ts`、`packages/backend/src/models/json-schema/note.ts`、`packages/misskey-js/src/autogen/` |
| 既存の公開条件 | Query/NoteEntity/shouldHideNote、skipHideの送信先、notes/show・children・conversation、SSR・embed・公開リンク・通知・ストリーム。新しい掲載閲覧ACLは作らず既存制限を維持 |
| RSS・退会 | `server/web/FeedService.ts` は通常投稿先で抽出。`queue/processors/DeleteAccountProcessorService.ts` は専用原本も墓標と削除配送を記録して一括削除 |
| 下書きとWeb UI | `packages/backend/src/models/NoteDraft.ts`、`core/NoteDraftService.ts`、`server/api/endpoints/notes/drafts/`、`packages/frontend/src/components/{MkPostForm,MkNote,MkNoteDetailed,MkNoteHeader,MkNotesTimeline}.vue`、`utility/get-note-menu.ts`、`locales/ja-JP.yml` |
| ピン留め | `packages/backend/src/server/api/endpoints/channels/update.ts`、`packages/frontend/src/utility/get-note-menu.ts`、掲載解除処理 |
| 連合の回帰確認 | `packages/backend/src/server/ActivityPubServerService.ts`、`core/NoteCreateService.ts`、`core/NoteDeleteService.ts`。形式変更が必要と判明した場合のみ `ApRendererService.ts` |

ぐりすぺには同名の取得・ストリームの多くに独自差分がある。段階1で `note-protocol.ts`、`GridspaceNoteService.read()`、`GridspaceSearchService`、`GridspaceActionService` と作成時の通常共有判定を変更する。`GridspaceReactionDeliveryService` と `GridspaceReactionNotificationService.receive` も通常・専用の共通分類へ移す。`GridspaceNotificationService` のチャンネル文脈も監査する。`GridspaceIdentityService`、`GridspacePrivateService`、`MkGridspacePostForm.vue` などの詳細は `plans/multi-note-peer.md` に分けて記す。上のファイル名を機械的にコピーせず、ぐりすぺの連携アカウントと `gridspaceShared` の条件を保って適用する。

## 段階と受け入れ条件

1. **保存・APIの準備**：migration、entity、掲載先サービス、冪等記録、永続ジョブ、`notes/create` を作る。全作成経路でフラグを確定し、旧APIと旧ノートの互換テストを通す。新APIをまだ公開しない。
2. **読取の統一**：DB取得、Redis再取得、ストリーム、プロフィール、検索、推薦、ロール・アンテナ一覧、ぐりすぺ通常共有を共通判定へ切り替える。取得先の指定忘れを検出し、旧単一チャンネルの表示を確認する。
3. **fanoutと付随処理**：通常・チャンネル両経路の書込、チャンネル集計、ランキング、削除・掲載解除、ピン留め、索引更新を実装する。ジョブ再試行を含め、投稿先の組合せを同一ノートIDで検証する。
4. **UIと段階公開**：投稿先シート、ノート上の掲載先表示、下書き、エラー復帰を実装。連携先チャンネルはまだ選択不可。サーバーとWeb UIの互換がそろってから新APIを開く。
5. **連携先**：ぐりすぺ固有の署名付き掲載プロトコルを別工程で実装し、双方向会話・認可・失敗時の再試行を満たしてから解禁する。

配備は「schema追加 → 全作成・読取経路に対応したサーバーとワーカーを両方へ配備 → 旧版プロセスの残存を確認 → バックフィル・Meilisearch再索引 → 読取結果・件数を照合 → 新UIと新APIの書込を有効化」の順にする。書込有効化前なら既存形式への切り戻しを検討できるが、有効化後は対応前の旧版サーバー・ワーカーへ戻してはいけない。途中停止は新規書込だけを止める機能フラグで行い、作成済みの新方式ノートを読むコード、掲載表、後続ジョブを残す。連携先の投稿先は段階5が両サーバーでそろうまで選択不可とする。

最低限の結合テストは、旧通常、旧単一チャンネル、新通常のみ、通常＋1/複数チャンネル、専用1/複数チャンネルを作り、投稿者・フォロワー・ミュート利用者・未ログイン利用者から照会する。fanout ON/OFF、Redis/DB、WebSocket、検索、解除後、ページングで重複と漏れを比較する。通常原本のCreate/Deleteは原本単位とし、専用原本は通常TL/RSS/共有/AP自動配送へ出さない。原本URL・会話・添付は解除前後とも既存の公開条件を維持する。退会、作成応答消失、localOnly投票、新規の親未解決/履歴先着も必須条件として確認する。

### 新方式の書込を有効にする条件

| 検証 | 合格条件 |
| --- | --- |
| 通常タイムライン | チャンネル専用原本・会話内だけの返信がDB、Redis、WebSocketのいずれにも混入しない。本人投稿の例外でも通らない |
| 公開条件と解除 | 解除は当該一覧・経路・ピン・集計から外し、直接URL・会話・添付の公開条件を変えない。既存ブロック・停止・サインイン要求・非表示時刻は維持 |
| 退会と復旧 | 一括削除でも全予定宛先へ削除を配送し、相手停止・再起動・再送で復活しない。確定待ち作成キーを復元し、相手prepare前にreceiptから結果を回収 |
| アンケート推薦 | `excludeChannels=true/false` の両方で旧・新の投稿先の扱いが仕様どおり一致し、ページングが崩れない |
| ぐりすぺ通常共有 | チャンネル専用原本を作成時、ID指定の取得、連携検索、アクションの各経路から通常共有へ出さない |
| 共通判定 | 取得先の指定なしを拒否。単一 `channelId` による通常判定の残存をCIで検出し、互換処理等の許可箇所には理由を記す |
| 取得経路の網羅 | エンドポイント・ストリーム・索引・集計の対応表を作り、QueryServiceを通らない直接取得も確認する。検索・ロール・アンテナへ通常専用条件を無条件に足さない |
| 移行と再試行 | 新規保存のフラグNULLなし、旧データの照合完了、removed行がバックフィルで復活しない。ジョブ再実行で原本・通知・集計が増えない |
| 会話と連合 | チャンネル専用への旧クライアント返信が通常経路へ出ず、通常＋チャンネル原本に対する連合からのAnnounce・引用を受信できる |
| 配備 | 新旧形式の読取に対応した全サーバー・ワーカーが稼働し、書込停止の機能フラグと切り戻し禁止の条件を運用手順へ記録済み |

実装変更時は最寄りのbackend/frontendテスト、変更ファイルのESLint、SPDX、locale安全性を確認する。APIスキーマ変更後は misskey-js を再生成し、entity・migration変更後は pending DDL 0件を確認する。

## 実装前に決める点

- チャンネルだけの投稿を通常検索で見せるか。旧チャンネル投稿の検索挙動と統一する方針を確定する。プロフィールは `withChannelNotes` 指定時のみ掲載原本を表示する案を維持する。
- チャンネルミュートは掲載経路のみ除外する案を具体化し、Renote対象のミュート・明示的に開いたチャンネル画面での例外を決める。
- 旧単一チャンネル投稿に対する管理者の掲載解除を初期版で扱うか。扱う場合は旧列の併読が解除済み掲載を復活させない仕組みが必要。
- 通常＋チャンネル原本と `allowRenoteToExternal=false` のチャンネルを組み合わせられるか。連合後の原本に対するAnnounceを壊さない方針とローカル操作の制限を確定する。
- チャンネル専用原本への返信は会話内だけとし、掲載先0件の例外と親の閲覧権を実装する。既存単一チャンネル返信の継承は維持する。
- センシティブ語・`canPublicNote` による公開範囲変更を、旧単一チャンネルと新しいチャンネル専用投稿でどうそろえるか。通常投稿先もある場合の拒否条件と合わせて確定する。
- 全掲載先を失った専用原本は通常配信せず、投稿者の管理画面に残す。原本と会話の直接取得は既存の公開条件を維持し、本人限定にはしない。最小の解除・削除記録は期限なしで保持する。
