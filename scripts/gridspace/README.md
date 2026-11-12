# GridSpace とれぞらぶの試験環境

二つのフォークを別のディレクトリでビルドし、`kokopi.me` の SSH トンネルからアクセスする。外部の連合相手を確認するため、連携拡張を入れない三つ目の checkout も用意する。各サイトの DB と Redis は独立している。

| 役割 | 公開 URL | ローカルの HTTP ポート |
| --- | --- | --- |
| G: GridSpace | `https://grid-space-misskey.kokopi.me` | 13000 |
| R: れぞらぶ | `https://resonite-love-misskey.kokopi.me` | 13001 |
| E: 通常の外部サーバー | `https://gridspace-e-dev.kokopi.me` | 13002 |

## 現在の実装範囲

実装済みなのは、明示的に有効化する peer API と署名つきの互換性確認である。`POST /gridspace/v1/handshake` は送信元、宛先、コミュニティ、キー ID、時刻、nonce、メソッド、パス、送信された本文のバイト列を検証する。nonce は Redis で一度だけ受け付ける。Redis が利用できない場合は処理しない。

機能一覧の `features` は `account-link-follow-copy`、`community-notes`、`member-history` を返す。設定の「アカウント連携」で OAuth の本人確認を行い、相手サーバーのフォローを一度だけコピーできる。新規投稿は共通 LTL と購読者のホームに届き、連携したプロフィールでは公開・ホームの過去履歴も読める。横断検索、通知の統合、旧名義での返信は後続の実装となる。サーバー同士が認証できても、利用者の限定投稿へアクセスする許可にはならない。

## 初回の準備

Node と pnpm は各 checkout の `package.json` に合わせる。Docker Desktop の Linux コンテナと、`ssh -T kokopi.me` で利用できる既存の SSH 認証が必要。SSH の鍵をコピーしたり新しい鍵を登録したりする処理は、この手順には含まれない。

G のリポジトリで実行する。引数は R と E のリポジトリのパスとする。

```powershell
node scripts/gridspace/setup-lab.mjs ../resonite-love-gridspace ../gridspace-external-test
docker compose --env-file .config/gridspace-lab.env -f compose.gridspace-test.yml up -d --wait
```

生成される `.config/gridspace-lab.yml` と `.config/gridspace-lab.env` は Git の管理対象外。DB パスワード、初回設定パスワード、G/R 間の共有キーをランダムに生成する。E には共有キーを渡さない。既存の試験設定があれば、スクリプトは上書きせずに停止する。

URL はアカウント作成前に確定する。試験データを作成した後、同じ DB の URL だけを変更しない。

各リポジトリで依存を導入してから、G のリポジトリで次を実行する。

```powershell
pnpm install --frozen-lockfile
./scripts/gridspace/run-lab.ps1 -Action build
./scripts/gridspace/run-lab.ps1 -Action migrate
./scripts/gridspace/run-lab.ps1 -Repository ../resonite-love-gridspace -Action build
./scripts/gridspace/run-lab.ps1 -Repository ../resonite-love-gridspace -Action migrate
./scripts/gridspace/run-lab.ps1 -Repository ../gridspace-external-test -Action build
./scripts/gridspace/run-lab.ps1 -Repository ../gridspace-external-test -Action migrate
```

`run-lab.ps1` は選んだリポジトリの試験設定と環境変数を使う。通常の `default.yml` は書き換えない。

## 起動と接続

サイトごとに別のターミナルで実行する。

```powershell
./scripts/gridspace/run-lab.ps1 -Action start
./scripts/gridspace/run-lab.ps1 -Repository ../resonite-love-gridspace -Action start
./scripts/gridspace/run-lab.ps1 -Repository ../gridspace-external-test -Action start
```

トンネルもそれぞれ別のターミナルで実行する。

```powershell
./scripts/gridspace/tunnel.ps1 -Role g
./scripts/gridspace/tunnel.ps1 -Role r
./scripts/gridspace/tunnel.ps1 -Role e
```

例えば G のトンネルは `ssh -T -R grid-space-misskey:80:127.0.0.1:13000 kokopi.me` に接続する。公開側で HTTPS を終端し、ローカルへ HTTP を転送する。トンネルは切断時に再接続するため、停止するときは実行したターミナルで Ctrl-C を押す。バックグラウンド起動した場合は、その起動時に記録したプロセスを停止する。

## 確認

両サイトを起動した後、G のリポジトリで実行する。

```powershell
node scripts/gridspace/probe-peers.mjs
pnpm --filter backend test --run src/core/gridspace/peer-protocol.test.ts src/core/gridspace/link-crypto.test.ts src/server/gridspace/peer-server.test.ts
```

probe は G→R と R→G の署名つきリクエストが成功し、同じリクエストの再送と不正な署名が拒否されることを確認する。本人のアクセストークンやノート本文は扱わない。単体試験の初回実行前には `.config/test.yml` を試験用の例から作成する。既にある場合は上書きしない。

### テスト用アカウントと通常連合

G のリポジトリで次を実行する。3 サイトが起動し、トンネル経由で応答する状態にしておく。

```powershell
node scripts/gridspace/seed-lab.mjs ../resonite-love-gridspace ../gridspace-external-test
node scripts/gridspace/test-lab.mjs ../resonite-love-gridspace ../gridspace-external-test
```

`seed-lab.mjs` は各サイトに `lab_admin`、`lab_author`、`lab_reader`、`lab_locked` を作る。`lab_admin` は初回の管理者、`lab_locked` は承認制のアカウントとする。一般登録を招待制にし、通常連合の接続先を上記 3 サイトの範囲に設定する。この処理は専用の URL とローカル DB ポートを照合し、異なる環境では停止する。

ログイン用パスワードとトークンは、各リポジトリの `.config/gridspace-lab-accounts.json` に保存する。表示や Git への追加はしない。同じファイルを保持した再実行ではアカウントを再利用する。パスワードを変更した場合は、このファイルも手元で更新してから再実行する。

`test-lab.mjs` はテスト投稿と Follow を作り、HTTPS、WebSocket の新着、3 サイト間の通常配送、ローカル限定の外部配送禁止、鍵アカウントの承認、通知を確認する。テスト投稿は履歴として残る。これは連携機能を追加する前の基準動作であり、本人連携や共通 LTL の受け入れ試験は含まない。

### OAuth 連携と初回コピーの試験

G と R のビルド・migration・起動と、テスト用アカウントの作成が終わった後に実行する。

```powershell
node scripts/gridspace/test-link.mjs ../resonite-love-gridspace
node scripts/gridspace/test-migrations.mjs
```

`test-link.mjs` は毎回専用アカウントを作り、OAuth、初回コピー、ホーム投稿の到着、鍵アカウントの承認待ち、ミュート対象の省略、二重連携の拒否、Follow の独立性、解除と再連携を確認する。専用アカウントは最後に連携済みの状態で残る。認証情報は G の `.config/gridspace-link-test-accounts.json` に保存する。

`test-migrations.mjs` は G の PostgreSQL に一時 DB を作り、新規 migration の up → down → up を確認してその DB を削除する。稼働中の Misskey のテーブルと利用者データは変更しない。

### 共通 LTL とローカル限定投稿の試験

`test-link.mjs` を一度実行した環境で、次を実行する。

```powershell
node scripts/gridspace/test-notes.mjs ../resonite-love-gridspace ../gridspace-external-test
pnpm --filter backend test --run src/core/gridspace src/server/gridspace
```

`test-notes.mjs` は専用アカウントを作り、LTL・ホーム・ソーシャルのライブ受信、フォローの有無、連携した自分の投稿、画像・CW・投票、返信・引用・Renote、通常連合との重複防止を確認する。外部サーバーへのローカル限定投稿の配送禁止と、投稿・専用アカウントを削除した後の表示取り下げも確認する。既存利用者のアカウントは削除しない。

DB からの取得を確認する間だけ G のタイムラインキャッシュを無効にし、終了時に元の設定へ戻す。共通 LTL は `gridspace.enabled` が有効な両サイトで動作する。投稿元の URI とアカウントを保持するため、通常の連合で先に受信していても別の投稿は作らない。

ビルドを更新した後は Misskey のプロセスを再起動し、ブラウザーも再読み込みする。起動中のサーバーは古いアセットの情報を保持するため、ファイルの置き換えだけでは画面を更新できないことがある。

### プロフィールと過去履歴の試験

```powershell
node scripts/gridspace/test-history.mjs ../resonite-love-gridspace ../gridspace-external-test
node scripts/gridspace/test-history-visibility.mjs ../resonite-love-gridspace ../gridspace-external-test
node scripts/gridspace/test-history-ui.mjs
```

履歴試験は専用の G/R/E 設定を照合し、新しいテスト用アカウントだけを使う。過去投稿は専用 DB 内にテスト行を作り、新着配送を伴わずに取得する状況を再現する。ページ間の新着、同一 ID・同文の別投稿、過去のローカル限定投稿、返信・引用・画像、ミュート・ブロック・削除・解除を確認する。未ログイン閲覧設定は一時的に変更し、終了時に戻す。

`test-history-visibility.mjs` は保存済みの限定投稿とチャンネル投稿を検証する。G/R 両方向で投稿者・フォロワー・指名先が本文を読めること、第三者・未ログイン・承認待ちの利用者には限定投稿が出ないことを確かめる。ページ間のフォロー解除、ミュート・ブロック、チャンネルミュートの期限切れ、連携先への権限の混同や限定投稿の複製がないことも確認する。認証情報は `.config/gridspace-visibility-test-accounts.json` に保存し、Git に追加しない。

画面試験はインストール済み Chrome と Playwright を使う。履歴試験が作成した `.config/gridspace-history-test-accounts.json` を読み、G/R の両アカウントの初期表示、表示をオフにするボタンがないこと、ページ追加、デスクトップ幅とスマートフォン幅を確認する。画像は `.config/history-*-desktop.png` と `.config/history-*-mobile.png` に保存する。認証情報と画像は Git に追加しない。

### 人物・過去投稿の検索試験

```powershell
node scripts/gridspace/test-search.mjs ../resonite-love-gridspace ../gridspace-external-test
node scripts/gridspace/test-search-ui.mjs
```

検索試験は新しい専用アカウントと履歴行を作り、未取得の過去投稿、本文・CW、人物の旧新名、公開範囲、ミュート・ブロック、動的な過去投稿の非表示、削除、ページ送りと連携世代を確かめる。G/R の既定ポリシーは、他の値を維持して `canSearchNotes: true` にする。この設定は画面の試用用に残す。テスト用アカウントだけに一時的な回数制限除外ロールを付け、終了時にロールを削除する。未ログイン閲覧設定も終了時に戻す。

認証情報は Git 管理外の `.config/gridspace-search-test-accounts.json` に保存する。画面試験は G/R の実 API で検索し、画像を `.config/search-*-desktop.png` と `.config/search-*-mobile.png` に保存する。部分応答を受けた画面の再試行は Playwright で応答を置き換えて検証する。

実際の停止・復旧は `node scripts/gridspace/test-search-outage.mjs prepare`、R の Misskey プロセスを停止して `during`、R を再開して `after` の順に実行する。これらの引数を省略しない。試験スクリプト自体はプロセスを停止しない。DB・Redis・トンネルは停止する必要がない。

### 旧アカウントの権限で読む限定投稿の試験

```powershell
node scripts/gridspace/test-private.mjs
node scripts/gridspace/test-mutual.mjs
node scripts/gridspace/test-private-ui.mjs
node scripts/gridspace/test-home.mjs
node scripts/gridspace/test-lists.mjs
```

実 OAuth で追加認可し、フォロワー限定・宛先限定の閲覧と検索、呼び出し元のスコープ、本文・CW・添付、解除・失効、両方向の取得を確かめる。専用アカウントと履歴行を作り、一時ロールは終了時に削除する。認証情報は Git 管理外の `.config/gridspace-private-test-accounts.json` に保存する。画面試験は Chrome を使い、画像を `.config/private-search-*.png` に保存する。

`test-home.mjs` は同じ専用アカウントで通常ホームを開き、旧側だけで読める投稿との混在表示、日時順のページ送り、25件の新着、通信失敗からの復旧、フォロー解除を確かめる。この試験で作った投稿と一時ロールは終了時に削除する。画像は Git 管理外の `.config/home-desktop.png` と `.config/home-mobile.png` に保存する。

`test-lists.mjs` は同じ専用アカウントで G/R のプロフィールと検索を開く。両サーバーで公開・宛先限定を各21件、合計84件作り、通常投稿と旧権限の限定投稿を混ぜた日時順のページ送り、重複防止、専用欄の撤去、空表示、再確認の失敗時の本文消去と再試行を確かめる。両方の取得経路で複数ページを読み、相互の投稿同期も並行するため、通信の待ち合いの再発確認に使える。作成した投稿と一時ロールは終了時に削除する。画像は Git 管理外の `.config/lists-*.png` に保存する。

`node scripts/gridspace/test-lists.mjs --mock` は、連携・投稿取得 API の応答を固定して同じ画面を検証する。このモードでは投稿と一時ロールを作成しない。サーバー間の通信や認可の検証には使わない。

`test-mutual.mjs` は直前に作った専用アカウントを使う。一度の認可での両方向の許可、通信境界の保存状態からの再試行、解除後の遅延要求、両側からの同時認可、通常のトークン削除を確認する。テスト中はそのアカウントの認可状態を変更し、終了時に新しい相互認可を残す。

実際の停止・復旧は `node scripts/gridspace/test-private-outage.mjs prepare`、R の Misskey プロセスを停止して `during`、再起動して `after` の順に行う。停止中の閲覧拒否と許可取り消し、復旧後の失効通知の再送を確認する。最後にテストアカウントだけを再認可する。DB・Redis・トンネルは停止しない。

### 旧名義での返信試験

```powershell
node scripts/gridspace/test-reply.mjs
node scripts/gridspace/test-reply-ui.mjs
```

API 試験で専用アカウントを作り、閲覧専用の許可と返信許可を区別して検証する。返信名義・宛先・「連合なし」、同時再試行の重複防止、削除後の再送拒否、権限の解除を確認する。一時ロールは終了時に削除する。認証情報は Git 管理外の `.config/gridspace-reply-test-accounts.json` に保存する。

画面試験は直前の API 試験のアカウントを使い、実 OAuth の追加許可、本文・CW の返信、通信の応答だけを失った場合の結果確認を行う。`.config/reply-desktop.png` と `.config/reply-mobile.png` に画面を保存する。再実行するときは API 試験から順に実行する。

### 通知統合の試験

```powershell
node scripts/gridspace/test-notifications.mjs
node scripts/gridspace/test-notifications-ui.mjs
```

API 試験は専用の G/R 設定を確認して、新しいテストアカウントを作る。追加認可、既存の返信許可の維持、逆向きの権限、85件ずつのページ送り、取得時の未読維持、個別既読、限定投稿の削除と認可解除を確認する。Redis の既読処理も独立したテスト用キーで実行する。

画面試験は `.config/gridspace-notification-test-accounts.json` のアカウントを使い、Chrome で認可・通知一覧・添付画像・更新・解除・通信失敗からの復旧を確認する。グループへの追加と既読は、応答を固定した画面試験でも確認する。画像は `.config/notifications-desktop.png` と `.config/notifications-mobile.png` に保存する。認証情報と画像は Git に追加しない。

## 旧名義での操作・表示・登録案内

G のリポジトリから `node scripts/gridspace/test-actions.mjs` を実行すると、両サーバーで追加の OAuth 許可、旧名義でのリアクション・投票・添付付き返信、権限制限を確認する。続けて `node scripts/gridspace/test-actions-ui.mjs` で、Chrome による操作、MFM・カスタム絵文字、実際の新規登録後の案内と初期設定の再開を確認する。

専用アカウントは Git 管理外の `.config/gridspace-actions-test-accounts.json` に保存する。画像は `.config/actions-mfm.png`、`.config/actions-mobile.png`、`.config/actions-signup.png` に保存する。ビルドとサーバーの再起動を済ませてから実行し、画面試験中はフロントエンドを再ビルドしない。

## 連携先の自動フォロー

両サーバーのビルド・migration・再起動後、G のリポジトリで `node scripts/gridspace/test-follow-expansion.mjs` を実行する。専用アカウントで、連携する順序、通常ホームへの配信、鍵付きアカウント、解除・却下、ミュート・ブロック、認可失効からの再開を確認する。テスト用ロールは終了時に削除する。認証情報は Git 管理外の `.config/gridspace-follow-expansion-test-accounts.json` に保存する。

## 停止と再開

試験環境を停止する場合は Misskey 本体とトンネルを停止し、次を実行する。DB のボリュームは保持される。

```powershell
docker compose --env-file .config/gridspace-lab.env -f compose.gridspace-test.yml stop
```

再開するときは Docker の `up -d --wait`、各サイトの `run-lab.ps1 -Action start`、`tunnel.ps1` を実行する。設定作成、アカウント作成、DB の作り直しは不要。PC の停止・スリープ中は公開 URL も利用できない。現構成には OS 起動時の自動起動を設定していない。
