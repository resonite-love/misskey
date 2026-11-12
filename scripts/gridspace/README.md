# GridSpace とれぞらぶの試験環境

二つのフォークを別のディレクトリでビルドし、`kokopi.me` の SSH トンネルからアクセスする。外部の連合相手を確認するため、連携拡張を入れない三つ目の checkout も用意する。各サイトの DB と Redis は独立している。

| 役割 | 公開 URL | ローカルの HTTP ポート |
| --- | --- | --- |
| G: GridSpace | `https://grid-space-misskey.kokopi.me` | 13000 |
| R: れぞらぶ | `https://resonite-love-misskey.kokopi.me` | 13001 |
| E: 通常の外部サーバー | `https://gridspace-e-dev.kokopi.me` | 13002 |

## 現在の実装範囲

実装済みなのは、明示的に有効化する peer API と署名つきの互換性確認である。`POST /gridspace/v1/handshake` は送信元、宛先、コミュニティ、キー ID、時刻、nonce、メソッド、パス、送信された本文のバイト列を検証する。nonce は Redis で一度だけ受け付ける。Redis が利用できない場合は処理しない。

機能一覧の `features` は現在空である。OAuth による本人連携、フォローの取り込み、共通 LTL、履歴・通知の統合、旧名義での返信は後続の実装となる。サーバー同士が認証できても、利用者の限定投稿へアクセスする許可にはならない。

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
pnpm --filter backend test --run src/core/gridspace/peer-protocol.test.ts src/server/gridspace/peer-server.test.ts
```

probe は G→R と R→G の署名つきリクエストが成功し、同じリクエストの再送と不正な署名が拒否されることを確認する。本人のアクセストークンやノート本文は扱わない。単体試験の初回実行前には `.config/test.yml` を試験用の例から作成する。既にある場合は上書きしない。

試験環境を停止する場合は Misskey 本体とトンネルを停止し、次を実行する。DB のボリュームは保持される。

```powershell
docker compose --env-file .config/gridspace-lab.env -f compose.gridspace-test.yml stop
```
