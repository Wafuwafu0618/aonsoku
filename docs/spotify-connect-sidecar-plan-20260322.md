# Spotify Connect Sidecar 実装計画（2026-03-22）

## 1. 目的（ゴール明確化）

- 最終ゴールは次のユーザーフローを成立させること。
  - Minato で楽曲を検索する
  - 再生先として Spotify Desktop クライアントを選ぶ
  - Minato から Spotify Desktop の再生を開始・制御する
- 既存の Local / Navidrome 再生経路は壊さない。
- `native/engine`（高音質系）とは分離し、Spotify 専用 sidecar を別プロセスで持つ。

## 2. 実装モード

- Mode A: Receiver mode（Minato 自身が Spotify Connect 受信機になる）
  - これは接続検証・デバッグに有効。
- Mode B: Controller mode（Minato が外部 Connect デバイスを制御する）
  - これが最終ゴールに必須（Spotify Desktop を再生先にする）。

## 3. 現在の到達点（2026-03-22時点）

- Mode A の土台は実装済み。
  - `initialize/startReceiver/status/dispose`
  - sidecar から `librespot` 子プロセスを起動・監視
  - 設定画面に検証UI追加
- Mode B は部分実装。
  - `listDevices / setActiveDevice / playUri` を sidecar command として実装
  - 設定画面で device選択・URI再生の手動検証が可能
  - 設定画面から OAuth(PKCE) で token取得/refresh を実行可能
  - `initialize.accessToken` にはOAuth結果をそのまま流し込める
  - 必要scope: `user-read-playback-state`, `user-modify-playback-state`
  - Spotify検索統合（Minato検索→`spotify:uri`取得）は未実装

## 4. 方針（確定）

- 新規プロセス: `native/spotify-connect-engine`
- Electron Main 経由で JSON IPC（stdin/stdout）接続
- Feature Flag で段階公開（既定OFF）
- Mode A を先に安定化し、Mode B を追加して最終ゴールを達成する

## 5. アーキテクチャ

1. Renderer
- 検索UI（Spotify候補）と再生先デバイス選択UIを持つ
- `spotify:` ソースを `spotify-connect` backend にルーティング

2. Preload
- Spotify sidecar API を `window.api` に追加

3. Electron Main
- `spotify-connect-sidecar.ts` で child process 管理
- IPC ハンドラで Renderer と sidecar を中継

4. Rust Sidecar
- Mode A: `librespot` を使った receiver 起動/監視
- Mode B: 外部 Connect デバイス制御のための command を提供
- main loop は command-response + async event

## 6. IPC契約（ドラフト）

### 6.1 Mode A（Receiver）

- `initialize`
  - params: `{ deviceName?: string, cacheDir?: string, zeroconfPort?: number, librespotPath?: string, accessToken?: string }`
- `startReceiver`
- `status`
- `dispose`

### 6.2 Mode B（Controller）追加予定

- `listDevices`（実装済み）
- `setActiveDevice`（実装済み）
  - params: `{ deviceId: string, transferPlayback?: boolean }`
- `playUri`（実装済み）
  - params: `{ spotifyUri: string, startAtSeconds?: number, deviceId?: string }`
- `pause`（未実装）
- `resume`（未実装）
- `next`（未実装）
- `previous`（未実装）
- `seek`（未実装）
  - params: `{ positionSeconds: number }`
- `setVolume`（未実装）
  - params: `{ volume: number }`

### 6.3 Response/Event 共通

- Response:
  - `{ kind: "response", id: string, ok: boolean, result?: object, error?: { code: string, message: string, details?: object } }`
- Event:
  - `ready`, `receiverStarted`, `receiverStopped`
  - `sessionConnected`, `sessionDisconnected`
  - `trackChanged`, `timeupdate`, `play`, `pause`, `ended`
  - `deviceListChanged`（Mode B 追加予定）
  - `error`

## 7. 変更対象

### 7.1 実装済み

- `native/spotify-connect-engine/**`
- `native/third_party/librespot-0.8.0/**`（配置移動済み）
- `electron/main/core/spotify-connect-sidecar.ts`
- `electron/main/core/spotify-connect-oauth.ts`
- `electron/main/core/events.ts`
- `electron/main/index.ts`
- `electron/preload/types.ts`
- `electron/preload/index.ts`
- `src/platform/contracts/desktop-contract.ts`
- `src/platform/adapters/spotify-connect-adapter.ts`
- `src/app/components/settings/pages/content/spotify-connect.tsx`

### 7.2 これから実装

- `src/playback/backends/spotify-connect-backend.ts`（Controller接続）
- `src/playback/backends/song-backend-factory.ts`（backend選択）
- `src/app/components/player/audio.tsx`（spotify-connect再生条件）
- `src/domain/mappers/navidrome/index.ts`（spotify曲の `playbackBackend` 反映）
- 検索・デバイス選択UI
- `electron-builder.yml`（sidecar/librespot同梱）

## 8. マイルストーン（改訂）

1. M1: Receiver基盤
- `initialize/startReceiver/status/dispose` 動作
- Minato を Connect デバイスとして検出可能

2. M2: Controller基盤
- デバイス列挙
- Spotify Desktop を再生先に選択可能
- `play/pause/seek/volume` の基本制御

3. M3: 検索統合
- Minato内検索で Spotify 曲候補を表示
- 選曲→`spotify:uri`→選択デバイスへ再生開始

4. M4: QA/配布
- Feature Flag 運用
- Windows/macOS/Linux 確認
- 回帰テスト完了

## 9. 受け入れ条件（最終）

- Minato で曲検索し、Spotify Desktop を再生先に選べる
- Minato から Spotify Desktop 再生を開始・制御できる
- Local/Navidrome に回帰がない
- エラー理由が UI に表示される
- sidecar 終了時にプロセスリークがない

## 10. 直近の次アクション

1. OAuth導線の安定化（エラーハンドリング/再認可UX）
2. OAuth token 永続化と自動更新（起動時）
3. `pause/resume/seek/volume` commandを追加
4. 検索結果から `spotify:uri` を渡す経路を追加
5. `spotify-connect-backend` 実装を接続
