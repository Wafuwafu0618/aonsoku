# Minato Remote Web フロントエンド計画書（2026-03-26）

## 1. ゴール
- 最終目標は「単なる再生リモコン」ではなく、**Minatoデスクトップで日常的に使う機能の大半をWebから扱える状態**にする。
- ただし実装は段階分割し、まずは「再生が確実に鳴る」「操作と状態がズレない」ことを最優先に進める。

## 2. 現在の固定前提
- セッションは **1クライアント排他** を継続（lease/heartbeat管理）。
- **破壊的操作は当面未対応**（全削除・一括変更・大規模編集）。
- 対象は **Navidrome + Local の song** を優先し、Apple MusicはNavidrome安定後に着手。
- 音声伝送は現時点で **WebSocket PCM** を主経路とし、HLSはv1主要経路から外す。

## 3. 現状（2026-03-26時点）
- Electron Main内にRemote Relayサーバー実装済み。
  - API/SSE/WS: `electron/main/core/remote-relay-manager.ts`
  - IPC型定義: `electron/preload/types.ts`
- Renderer連携（状態送信/コマンド受信）実装済み。
  - 状態送信・コマンド適用: `src/store/player-controller.ts`
- Remote Web UIはMain内の埋め込みHTMLで稼働中（最小UI）。
  - 現状はプレイヤー最小操作に限定され、Minato本体UIとの見た目/構造パリティは未達。

## 4. 主要方針（今回の軸）
- **見た目はMinato既存コンポーネントをそのままモバイルへ落とし込む。**
  - 「新しい別デザイン」は作らない。
  - `src/app/components/*` を基準に、レイアウトのみモバイル向けに再配置する。
- 再生制御は新規ロジックを増やさず、既存のstore action経路を使う。
- 「Web専用の再生状態」を持ちすぎない。SSE状態を単一の正として扱う。

## 5. UIパリティ設計（Desktopコンポーネントをそのまま移植）

### 5.1 コア移植対象（P1-P2）
- Track情報
  - `src/app/components/player/track-info.tsx`
- 再生コントロール
  - `src/app/components/player/controls.tsx`
- 進捗シーク
  - `src/app/components/player/progress.tsx`
- 音量
  - `src/app/components/player/volume.tsx`
- Queue表示
  - `src/app/components/queue/song-list.tsx`

### 5.2 モバイル再配置ルール
- PCの3カラムプレイヤーを、モバイルでは縦1カラムに再配置。
- 部品の見た目（アイコン、サイズ比、余白感、フォント階層）は既存を維持。
- 小画面時のみ次を許可。
  - テキスト省略（marquee/ellipsis）
  - 非本質ボタンの折りたたみ
  - シート/タブ化による配置変更

## 6. 情報設計（モバイル画面構成）
1. 接続ヘッダー
- session状態、接続品質、出力経路（ws-pcm + sample rate）

2. Now Playing領域
- ジャケット、タイトル、アーティスト、アルバム、source

3. Transport領域
- prev / play-pause / next
- seek bar + 経過/総時間
- volume slider

4. 拡張領域（タブ）
- Queue
- Library（Navidrome）
- Search

## 7. フロントエンド実装アーキテクチャ

### 7.1 クライアント構成
- 現行のMain埋め込みHTMLは段階的に縮小し、**React製Remote Webクライアント**へ置き換える。
- 推奨配置（新規）
  - `src/remote-web/*`（Remote専用のエントリ/ルート）
- 既存`src/app/components/*`をimportし、Remote用コンテナだけを新規作成する。

### 7.2 通信
- Session
  - `POST /api/remote/session/claim`
  - `POST /api/remote/session/heartbeat`
  - `DELETE /api/remote/session/release`
- State
  - `GET /api/remote/events`（SSE）
  - `GET /api/remote/state`
- Command
  - `POST /api/remote/commands`
- Audio
  - `GET /ws/audio?leaseId=...`

### 7.3 状態モデル（Remote Web）
- `session`: leaseId, ownership, lastHeartbeatAt, isActive
- `playback`: nowPlaying, isPlaying, progressSec, durationSec, volume
- `transport`: wsConnected, sampleRate, channels, bufferedMs
- `ui`: isSeeking, isAdjustingVolume, pendingCommand, lastError

## 8. 機能ロードマップ（Minato機能の大半をWebで扱うまで）

### Phase 0: 土台固定（短期）
- 目的: 既存WS PCM経路を前提にUI刷新へ進める準備。
- タスク
  - Remote WebをReact化するディレクトリ構成を作成
  - Main埋め込みHTMLから段階移行できる配信方式を整理
  - 現行API/イベント契約のドキュメント化
- 完了条件
  - 最小再生UIがReact版で同等動作

### Phase 1: Playerパリティ（最優先）
- 目的: デスクトップPlayerの見た目/操作感をモバイルで再現。
- タスク
  - `track-info` / `controls` / `progress` / `volume` を移植
  - session状態と再接続導線をUIへ統合
  - command失敗時のロールバックと通知統一
- 完了条件
  - iOS/Android実機で10分以上連続再生
  - play/pause/prev/next/seek/volumeの整合性100%

### Phase 2: Queue + Library（Navidrome）
- 目的: Web単体で曲選択と再生開始まで完結。
- タスク
  - Queue一覧・先頭再生・現在曲追従
  - Navidrome検索、アルバム/アーティスト導線
  - キュー追加（非破壊操作のみ）
- 完了条件
  - 「検索→再生→キュー確認」がWebだけで完結

### Phase 3: パリティ拡張（非破壊操作中心）
- 対象
  - shuffle/repeat
  - like/unlike
  - lyrics表示（閲覧中心）
  - signal path表示（閲覧）
- 完了条件
  - デスクトップ主要日常操作の大半をWebで実行可能

### Phase 4: 高度機能（慎重解放）
- 対象
  - 一部設定編集
  - playlist編集の段階開放
- 注記
  - 破壊的操作はこのPhaseでも原則保留。設計合意後に別チケット化。

### Phase 5: Apple Music対応（後段）
- Navidrome経路安定後に分離実装。

## 9. API/IPC拡張方針（将来パリティ用）
- 既存 `RemoteRelayCommandType` は最小操作のみ。
- 将来拡張は次の順で増やす。
  1. 非破壊コマンド（shuffle/repeat/like）
  2. キュー編集（move/remove）
  3. 設定系（閲覧→限定編集）
- 追加時は必ず
  - `electron/preload/types.ts`
  - `electron/main/core/remote-relay-manager.ts`
  - `src/store/player-controller.ts`
  の3点を同時更新する。

## 10. テスト戦略

### 10.1 単体
- セッション排他（2台目reject/takeover）
- heartbeat timeout解放
- command変換（HTTP -> IPC -> store action）
- optimistic update + rollback

### 10.2 結合
- Renderer状態変更がSSEへ反映
- Web操作とDesktop UI状態の不整合が発生しない
- デスクトップ停止操作時、Web音声も停止する

### 10.3 実機E2E
- iOS Safari / Android Chrome
- Cloudflare Tunnel + Access経由
- 通信揺れ、バックグラウンド復帰、再接続

## 11. 非機能要件
- 操作応答: 体感200ms以内を目標
- 再接続: セッション再取得を10秒以内に収束
- 観測性: session/command/audio websocketのログを統一
- 安全性: ローカルHTTPは `127.0.0.1` bind前提、外部公開はTunnelのみ

## 12. 直近TODO（着手順）
1. Remote WebをReactエントリ化し、現行埋め込みHTMLを置換可能にする。
2. `player/track-info` `player/controls` `player/progress` `player/volume` の4部品をモバイル再配置で移植する。
3. Queueタブを追加し、`queue/song-list` をそのまま流用して最小機能を提供する。
4. Navidrome検索導線を実装し、Web単体で再生開始まで完結させる。
5. 上記完了後にApple Music向け計画を別ドキュメントとして分離する。

