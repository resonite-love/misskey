# Multi Note 計画 再レビュー（`includeDefault` + `note_channel_placement` 案）

> 2026-11-21の照合追記：以下はレビュー時点の出力。指摘4の「れぞらぶにはGridSpaceがない」という前提は調査対象の取り違えだった。既存実装は `C:/Users/neo/GitHub/resonite-love-gridspace` の `codex/gridspace-bridge`（確認時 `b8d8c70373`）にあり、GridSpaceサービスとサーバー登録を確認した。ブリッジを含まない計画用ツリーの不在を、両サイトの未連携の根拠にはできない。既存ブリッジの基点確認と両方向への拡張を計画に記録した。本番の配備リビジョンは未確認。以下のレビュー本文は履歴として残す。

## 結論

- **基盤実装:** 条件付きで開始できます。共通判定、取得文脈の必須化、アンケート推薦の原本参照、配備順と旧版禁止は、前回の重大指摘に計画上で答えています。ただし次の3点は実装の土台そのものなので、着手前に決めてください。
  - 新しい列が NULL を取る3値設計と既存行の全件バックフィル（指摘3）
  - 永続ジョブの方式と範囲（指摘6）
  - GridSpace がどちらのリポジトリにあるか（指摘4）
- **新規書込の公開:** 現計画のままでは公開できません。段階1でも、ぐりすぺ私的連携でチャンネル専用原本が通常投稿に見えます（指摘1）。相手サーバーに一度複製された原本を取り消す手段もありません（指摘2）。

読み取りのみで、ファイル編集・コマンド実行・外部送信はしていません。

---

## 前回の重大指摘の解消状況

| # | 前回指摘 | 判定 | 残っている不足 |
|---|---|---|---|
| 1 | 通常経路への混入、推薦・ロール・アンテナの漏れ | **ほぼ解消** | 推薦は原本 `note` を JOIN し、LIMIT の前に判定する方針になった（timeline.md:93-97）。`roles/notes`・`antennas/notes` も対象に入った。経路表から `role-timeline`・`antenna`・`hashtag` ストリームと `addNoteToRoleTimeline` が抜けている（指摘12）。 |
| 2 | ぐりすぺ連携からの露出 | **部分的** | `canShareGridspaceNote`・`read()`・検索・アクション・返信は段階1の対象になった。ただし `GridspacePrivateService` を段階2に回しているため、段階1で誤判定が起きる（指摘1）。複製済みの原本を取り消す経路もない（指摘2）。 |
| 3 | 旧版への切り戻し | **運用制約として解消** | 書込開始後は戻せないこと、`down` を新データが無い場合に限ることは明記された。一方で、代表チャンネル案を退けた理由が残っていない。技術的な歯止めもない。旧版へ戻すと相手サーバーへの複製が起き、取り返せないことも書かれていない（指摘2・13）。 |
| 4 | 返信と Renote | **方向は解消** | 返信の扱いを `create()` で確定する方針と、受信 Announce を壊さない方針になった。ローカル操作を拒否する境界が `notes/create` なのか `fetchAndCreate` なのかが未定（指摘7）。解除済みの旧単一チャンネル投稿への返信の扱いも未定（指摘8）。 |
| 5 | 書込後の整合 | **方向のみ** | 「同一トランザクションに永続ジョブを記録する」とは書かれた。方式、対象の範囲、二重加算の防ぎ方が未設計（指摘6）。 |
| 補足 | `NOT IN` が NULL の行を落とす件、`EXISTS` の性能、`packMany` での一括読込 | **解消** | timeline.md:89, 105。 |
| 補足 | 通常検索の扱い、センシティブ語・`canPublicNote` | **判断待ち（明示済み）** | 重複報告はしません。`canPublicNote` だけは UI 工程の前提に関わるので、「決める点」に再掲します。 |

---

## 新規・残存の指摘

### 1. 【高・計画不足】段階1でも `GridspacePrivateService` / `GridspaceReplyService` がチャンネル専用原本を通常投稿と誤認する

- **根拠:**
  - ぐりすぺ: `core/gridspace/GridspacePrivateService.ts:131, 153, 168-169, 275, 307, 347, 461`
  - ぐりすぺ: `GridspaceReplyService.ts:44, 59, 101`
  - peer.md:22 はこの私的経路を「段階2で拡張」としている
- **失敗例1:** チャンネル閲覧だけを許されたゲスト（`channelActorId`）が、ある投稿を起点に同じ投稿者の文脈を開く。168-169行の `note.channelId IS NULL AND visibility IN ('public','home')` に、新形式のチャンネル専用原本が一致する。結果、別チャンネルにだけ載せた投稿を相手サーバーの利用者が読める。
- **失敗例2:** 連携利用者が自分のチャンネル専用原本を self-renote する。59行の `parent.channelId ?? null` と `input.channelId ?? null` はどちらも null になり、一致判定を通る。`replyAudience(parent)` で通常の公開範囲の Renote が作られる。
- **推奨:**
  - peer.md の段階1の表に、`GridspacePrivateService` の home / context / withChannelNotes 判定と、`canDelete`・`extendedReactions`・collection 経路を加える。
  - `GridspaceReplyService` については、親の一致判定を「通常投稿先の有無」と「掲載先」の組で行うと明記する。
  - 段階2で拡張するのは「連携先への掲載」だけとし、段階1では通常判定の置換を必須にする。

### 2. 【高・計画不足】一度相手サーバーへ複製された原本は、後から取り消せない

- **根拠:**
  - ぐりすぺ: `GridspaceNoteService.ts:157` — `bundle.unavailable` なら `return false` し、既存の複製に触れない
  - 同 `:94` — `read()` が `gridspaceShared=true` に書き換える
- **失敗例:** 判定漏れのバグか、禁止されている旧版への切り戻しで、チャンネル専用原本の `read()` が一度でも成功する。相手側の LTL に `gridspaceShared` の複製が残る。修正版に戻すと `unavailable` を返すが、相手の複製は消えない。
- **推奨:** 段階1の公開条件に次の2点を加える。
  - 以前共有した原本が共有対象外になったときの取り消し手段（`unavailable` を受けたら複製を消す、または source から取り消しを配送する）
  - 誤共有に気付いたときの是正手順
- 旧版禁止の理由に「相手サーバーへの複製が起き、取り返せない」を追記する。

### 3. 【高・計画不足】NULL を許す列の全件バックフィルと CHECK 制約が、既存データと衝突する

- **根拠:**
  - migration には、チャンネル投稿の `localOnly` を true に揃えた履歴がない（`migration/` を grep して確認）。強制しているのは現行コードの `NoteCreateService.ts:474` だけ。
  - ぐりすぺでは、連合由来の返信がチャンネルを継承しつつ `gridspaceShared=true` になり得る（`ApNoteService.ts:325`、`NoteCreateService.ts:465`）。
  - 計画の該当箇所: timeline.md:35-46, 60
- **失敗例1:** `channelId IS NOT NULL` の行を `includeDefault=false` に埋める途中で、昔の `localOnly=false` のチャンネル投稿が CHECK に違反し、バックフィルが止まる。
- **失敗例2:** `CHECK ... NOT VALID` にしても、PostgreSQL は UPDATE のたびに新しい行を検査する。旧行のリアクション数を更新するだけで失敗し得る。
- **失敗例3:** 巨大な `note` 表の全行 UPDATE で、表の肥大と WAL が膨らむ。
- **推奨:** `includeDefault boolean NOT NULL DEFAULT true` を検討する。
  - PostgreSQL 11以降では、既定値付きの列追加はメタデータの変更だけで済む。
  - 判定は「通常投稿先あり := `includeDefault AND channelId IS NULL`」とする。旧チャンネル投稿は `channelId` で除外されるので、フラグのバックフィルが不要になり、NULL の互換条件が判定式から消える。
  - CHECK は `NOT VALID` で追加し、後から `VALIDATE` する。追加前に、違反候補（`channelId IS NOT NULL AND localOnly=false` と、ぐりすぺの `gridspaceShared` 行）を数える手順を入れる。
  - 現案を維持する場合は、上の違反行をどう扱うかを先に決める。

### 4. 【高・意思決定不足】れぞらぶのリポジトリには GridSpace が存在しない

- **根拠:** れぞらぶの `packages/` 全体で `gridspace` が0件。一方、multi-note.md:67, 151-152 は、れぞらぶ側の計画で `gridspace/channels`・`MkGridspacePostForm.vue`・`pages/gridspace-channels.vue` を使う前提になっている。peer.md:54 も「れぞらぶの限定ミラー」を想定している。
- **失敗例:** 段階2の「同じ画面でれぞらぶ #B とぐりすぺ #C を選ぶ」は、れぞらぶに連携プロトコル全体を移植しないと成立しない。段階1でも、れぞらぶ側の変更対象ファイル表が実在しないファイルを指している。
- **推奨:** どちらかを明記する。
  - 本番のれぞらぶがぐりすぺのコードで動いている場合: 配備物とリポジトリの対応
  - そうでない場合: 段階2を「GridSpace をれぞらぶへ移植する」別計画にする
- れぞらぶ側の計画からは GridSpace の項目を外すか、「ぐりすぺのみ」と注記する。

### 5. 【中〜高・意思決定不足】掲載先の上限がないため、荒らしと負荷に対する歯止めがない

- **根拠:** multi-note.md:34「固定上限なし、既存の投稿頻度制限を維持」。現行の制限は1リクエスト単位。
- **失敗例:**
  - 1回の投稿で全公開チャンネルに掲載でき、頻度制限を実質的に回避したスパムになる。
  - 掲載先数に比例して、`channelPlacements` 入りの packed note がストリーム（Redis pub/sub）と全 WebSocket で配信される。
  - ジョブ1件の中で、全チャンネルのフォロワーの和集合を計算することになる。
- **推奨:** 製品として固定上限は置かなくてよい。代わりに次を入れる。
  - ロールポリシー（例: `maxChannelPlacementsPerNote`）と、掲載数で重み付けした頻度制限
  - packed note の `channelPlacements` は先頭 N 件と総数に絞る

### 6. 【中〜高・計画不足】永続ジョブの方式と範囲が決まっていない

- **根拠:**
  - 作成後の処理は現状すべて `setImmediate` で動く（`NoteCreateService.ts:668-671, 780-980`）。キューは Redis の BullMQ で、DB に outbox はない。
  - ぐりすぺには `MiGridspaceNoteDelivery` というポーリング型の先例がある（`GridspaceNoteService.ts:61-81`）。ただし再試行の上限がない。
- **失敗例:**
  - 受信を含む全ノートを DB outbox に通すと、連合受信の多いサーバーで書込量が増え、ポーリングの分だけタイムラインが遅れる。
  - 新形式だけを通すと処理経路が二重になる。
  - `LPUSH`・`increment`・`createNotification` は冪等でないので、再実行するとチャンネルの件数や通知が二重になる。
- **推奨:** 実装前に次を決める。
  - 対象: 新形式のローカル投稿だけか
  - 方式: DB outbox か、「コミット後に `jobId=noteId` で BullMQ に投入し、取りこぼしを掃除する処理を併用」か
  - ジョブへ移す処理: fanout・集計・索引のみか、通知・AP 配送・ストリーム送信も含むか
  - 二重加算の防止: 例えば掲載行に `countedAt` を持たせ、`UPDATE ... WHERE countedAt IS NULL RETURNING` で一度だけ加算する
  - 失敗の上限

### 7. 【中・計画不足】ローカル操作を拒否する境界を `fetchAndCreate` に固定していない

- **根拠:**
  - `allowRenoteToExternal` の検査は `fetchAndCreate` にだけある（`NoteCreateService.ts:363-374`）。
  - `fetchAndCreate` の呼出元は `notes/create`、`PostScheduledNoteProcessorService.ts:43`、ぐりすぺの `GridspaceReplyService.ts:89`。
  - 連合受信は `create()` を直接呼ぶ（`ApNoteService.ts:316`、`ApInboxService.ts:363`）。
- **失敗例:** チャンネル専用原本の Renote 拒否を `notes/create` に置くと、予約投稿とぐりすぺ経由の self-renote・返信がすり抜ける。`create()` に置くと、連合からの Announce まで拒否してしまう。
- **推奨:** 次のように明記し、呼出元ごとのテストを受け入れ条件に加える。
  - 「ローカル操作の拒否は `fetchAndCreate`」
  - 「公開範囲・投稿先の確定は `create()`」

### 8. 【中・意思決定不足】旧単一チャンネル投稿の掲載解除は、読取以外の箇所でも復活する

- **根拠:** `channelId` を書込側で使う箇所が多い。
  - 返信の継承: `NoteCreateService.ts:455-467`
  - 外部 Renote の可否: `NoteCreateService.ts:363`
  - 非正規化の複製: `renoteChannelId`（`NoteCreateService.ts:712`）、`poll.channelId`（同 `:751`）
  - チャンネルランキング: `ReactionService.ts:252`、`NoteCreateService.ts:1010`
  - ミュート判定: `is-channel-related.ts:19`
  - 検索索引: `SearchService.ts:163`
  - packed note の `channel`: `NoteEntityService.ts:386`
- **失敗例:** #C から外した旧投稿に返信すると、返信が #C に入る。書込開始前に掲載解除を出した後で旧版へ戻すと、旧版が #C に再表示する。
- **推奨:** 段階1では旧単一チャンネル投稿の掲載解除を扱わず、解除機能そのものを書込開始フラグの後ろに置く。扱う場合は上の全箇所を対象に列挙する。どちらの場合も「`channelId` を NULL にする移行は禁止」を明記する。現案では、`includeDefault` が NULL のまま `channelId` だけ NULL にすると通常投稿に変わってしまうため。

### 9. 【中・計画不足】「会話内のみの返信」と「掲載先が0件になった原本」を区別できない

- **根拠:** multi-note.md:129 は「配信区分」という言葉を使うが、列としては定義していない。timeline.md:64, 97, 168。
- **失敗例:** 全掲載先を解除された原本と会話内のみの返信は、どちらも `includeDefault=false` で掲載0件になる。推薦から除外する条件、返信の継承、復旧時の扱いを区別できない。
- **推奨:** 区分を列で持つ（例: `distribution enum('default','channels','thread')`）。会話内のみの返信の公開範囲（親を継承するか、`home` への格下げを許すか）も併記する。

### 10. 【中・計画不足】書込開始前の「取得経路の照合」に、検証用の新形式データがない

- **根拠:** multi-note.md:165、timeline.md:141。新形式の行は書込開始まで存在しない。
- **推奨:** 次の段階を、全体公開の前に入れる。
  - 本番データの複製を使った検証環境
  - スタッフのロールに限った書込有効化（カナリア）
- 書込停止フラグを、ロール単位で有効化できる形にする。

### 11. 【中・計画不足】移行期間中のチャンネル一覧の併読がクエリを重くする

- **根拠:** `channels/timeline.ts:120` は `note.channelId` の索引を使っている。計画は「旧列と新表を併読」（timeline.md:82）。
- **失敗例:** 2つの表にまたがる OR / UNION でページングが遅くなる。
- **推奨:** 新表は、掲載のバックフィル完了と照合が済むまで読まない。済んだ時点で新表だけに切り替える。旧 API も初日から新表に書くので、切替後に旧列を併読する必要はない。

### 12. 【低・計画不足】取得経路の表に漏れがある

- **根拠:**
  - `RoleService.addNoteToRoleTimeline`（`RoleService.ts:655`）と `role-timeline` ストリーム
  - `antenna` ストリーム
  - `hashtag` ストリーム（`hashtag.ts:51`、チャンネルの絞り込みなし）
  - `notes/search-by-tag`、`notes/featured`
- **推奨:** timeline.md:125 のストリーム一覧と、経路の対応表に加える。旧チャンネル投稿と同じ扱いにするなら、そう明記する。

### 13. 【低〜中・計画不足】旧版禁止に技術的な歯止めがない

- **根拠:** 旧版のコードは未知の migration やフラグを見ない。
- **推奨:**
  - 配備パイプライン側で、書込開始フラグが立っている間は互換版より古いイメージを拒否する。
  - 代表チャンネル案を退けた理由を、計画またはレビュー記録に残す。

### 14. 【低・計画不足】冪等キーの仕様が曖昧

- **推奨:** 次を定義する。
  - 必須か任意か（旧クライアントは送らない）
  - 一意にする範囲と保持期間
  - 同じキーで内容が違うときの応答（409 など）
  - 既存の `duplicated` エラーとの関係
- ぐりすぺの `MiGridspaceReplyReceipt`（`requestHash` で照合）の方式を流用できる。

### 15. 【低】掲載表の監査とカスケード削除が矛盾する

- **根拠:** multi-note.md:112 は「削除済みの状態を監査できる形」、timeline.md:48 は「原本削除時に CASCADE で掲載を消す」。
- **推奨:** どちらかに統一する。チャンネル側の外部キーの `ON DELETE` 動作も明記する。

---

## 実装開始前に決めること

1. `includeDefault` は NULL を許すか、`NOT NULL DEFAULT true` にするか。CHECK を導入する手順と、既存の違反行の扱い（指摘3）
2. 永続ジョブの方式、対象範囲、二重加算の防ぎ方（指摘6）
3. GridSpace をどちらのリポジトリが持つか（指摘4）
4. 配信区分を列で持つか（指摘9）
5. 掲載数のロールポリシーと、重み付きの頻度制限（指摘5）
6. ローカル操作の境界は `fetchAndCreate` とすること（指摘7）。旧単一チャンネル投稿の掲載解除は段階1で扱わない（指摘8）
7. UI 工程の前に: `canPublicNote=false` の利用者がチャンネル画面から投稿するときの扱い。新方式では投稿が拒否される計画なので、旧方式では投稿できた利用者が後退する。チャンネル1件だけの投稿は旧 API を使うか、旧来の規則を適用するかを決める。

---

## 判定

| 項目 | 判定 |
|---|---|
| 基盤実装（schema・共通判定・取得文脈の必須化・読取経路の切替） | **条件付きで開始可。** 上記の1〜3を先に確定すること。新規書込を無効にしたまま進められる。 |
| 新規書込の公開 | **不可。** 指摘1・2（段階1の連携経路と取り消し手段）、6（永続ジョブ）、10（カナリア）を計画に入れたうえで、各受け入れ条件を満たす必要がある。 |

なお、このセッションでは Google Calendar / Drive、Slack、Linear など一部の MCP コネクタが未認証で使えません。必要な場合は claude.ai のコネクタ設定、または対話セッションの `/mcp` で認証してください。
