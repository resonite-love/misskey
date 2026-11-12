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
node scripts/gridspace/test-history-ui.mjs
```

履歴試験は専用の G/R/E 設定を照合し、新しいテスト用アカウントだけを使う。過去投稿は専用 DB 内にテスト行を作り、新着配送を伴わずに取得する状況を再現する。ページ間の新着、同一 ID・同文の別投稿、過去のローカル限定投稿、返信・引用・画像、ミュート・ブロック・削除・解除を確認する。未ログイン閲覧設定は一時的に変更し、終了時に戻す。

画面試験はインストール済み Chrome と Playwright を使う。履歴試験が作成した `.config/gridspace-history-test-accounts.json` を読み、G/R のページ追加、表示の切り替え、キーボード操作、デスクトップ幅とスマートフォン幅を確認する。画像は `.config/history-*-desktop.png` と `.config/history-*-mobile.png` に保存する。認証情報と画像は Git に追加しない。

## 停止と再開

試験環境を停止する場合は Misskey 本体とトンネルを停止し、次を実行する。DB のボリュームは保持される。

```powershell
docker compose --env-file .config/gridspace-lab.env -f compose.gridspace-test.yml stop
```

再開するときは Docker の `up -d --wait`、各サイトの `run-lab.ps1 -Action start`、`tunnel.ps1` を実行する。設定作成、アカウント作成、DB の作り直しは不要。PC の停止・スリープ中は公開 URL も利用できない。現構成には OS 起動時の自動起動を設定していない。
