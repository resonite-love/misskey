# れぞらぶリレー (ReZoLove Relay) 仕様書

## 概要

Resonite Love関連のMisskeyサーバーから投稿を集約する専用タイムライン機能。

## タイムライン一覧

### れぞらぶリレー (`rl-relay`)

| 項目 | 値 |
|------|-----|
| タイプ | `rl-relay` |
| 表示名 | れぞらぶリレー |
| 説明 | れぞらぶリレーの投稿が見れます |
| アイコン | ロケット (`ti ti-rocket`) |
| 利用条件 | グローバルタイムラインが有効な場合 |

**動作:**
- `notes/global-timeline` を使用
- ローカル + `rlRelayHosts` の投稿のみ表示

### れぞらぶソーシャル (`rl-relay-social`)

| 項目 | 値 |
|------|-----|
| タイプ | `rl-relay-social` |
| 表示名 | れぞらぶソーシャル |
| 説明 | ホームタイムラインとれぞらぶリレータイムラインの投稿が両方表示されます |
| アイコン | ハート (`ti ti-heart`) |
| 利用条件 | ログイン必須 + グローバルタイムラインが有効な場合 |

**動作:**
- `notes/hybrid-timeline`（ホーム+ローカル）と `notes/global-timeline`（rlRelayHostsのみ）を並行取得
- 両方の結果をマージ・重複排除・時系列ソート
- ストリーミングも両チャンネル（`hybridTimeline` + `globalTimeline`）を購読

## 参加サーバー（リレーホスト）

| # | ホスト |
|---|--------|
| 1 | `misskey.kontovr.site` |
| 2 | `ningen.ahoaho.jp` |
| 3 | `misskey.resonite.love` |
| 4 | `mi.harumakizaemon.net` |
| 5 | `kawane.misskey.online` |
| 6 | `pl.ijs01140.dev` |

## 主要ファイル

| ファイル | 説明 |
|---------|------|
| `packages/frontend/src/components/MkStreamingNotesTimeline.vue` | メインのタイムライン実装 |
| `packages/frontend/src/timelines.ts` | タイムライン定義 |
| `packages/frontend/src/store.ts` | ストア設定 |
| `packages/frontend/src/ui/deck/tl-column.vue` | デッキカラムUI |
| `packages/frontend/src/tips.ts` | ヒント定義 |
| `locales/ja-JP.yml` | ロケール定義 |

## 関連機能

`vmimi-relay`（ぶいみみリレー）と同様の仕組み。特定コミュニティ向けのキュレーションタイムライン。
