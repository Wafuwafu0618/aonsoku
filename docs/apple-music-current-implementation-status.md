# Apple Music 実装状況（2026-03-23時点）

## 目的

本ドキュメントは、Apple Music 連携の「現在の実装状態」を共有するための現状報告です。  
実装計画書（`docs/apple-music-ui-implementation-plan.md` / `docs/apple-music-token-fetch-plan.md`）との差分を含めて、現時点で動いている経路を明確化します。

---

## 現在の方式（確定）

- **旧方式（トークン傍受してRendererで利用）を廃止**
- **新方式（`music.apple.com` の BrowserWindow セッション内で API 実行）を採用**

要するに、Renderer で `Developer Token` / `Music User Token` を直接管理せず、Electron Main 側の同一セッション上で Apple Music API を実行する構成に切り替え済み。

---

## 実装済み

### 1. Main: BrowserWindow セッション API 実行基盤

- ファイル: `electron/main/core/apple-music-browser-api.ts`
- 実装内容:
  - `partition: 'persist:apple-music-auth'` の専用セッションを使用
  - サインイン用ウィンドウ `openAppleMusicSignInWindow()` を提供
  - バックグラウンド worker window を保持し、`executeJavaScript` で MusicKit API を呼び出し
  - 対応アクション:
    - `status`
    - `search`
    - `catalog-album`
    - `catalog-playlist`
    - `library`
  - `library` は `songs/albums/playlists` を抽出して返却（raw payload も保持）

### 2. Main: リクエストデバッグとヘッダー補完

- ファイル: `electron/main/core/events.ts`
- 実装内容:
  - `onBeforeSendHeaders` / `onCompleted` / `onErrorOccurred` で Apple Music API リクエストを記録
  - 直近のデバッグ情報を `AppleMusicGetLastRequestDebug` IPC で取得可能
  - `api.music.apple.com` 宛に限り、`music-user-token` が欠けて `media-user-token` がある場合は  
    `Music-User-Token` を補完して送信する処理を追加

### 3. IPC: 新フロー向けチャネル追加

- ファイル:
  - `electron/preload/types.ts`
  - `electron/preload/index.ts`
  - `electron/main/core/events.ts`
- 追加済みチャネル:
  - `AppleMusicOpenSignInWindow`
  - `AppleMusicApiRequest`
  - `AppleMusicGetLastRequestDebug`
- Renderer API:
  - `window.api.appleMusicOpenSignInWindow()`
  - `window.api.appleMusicApiRequest(...)`
  - `window.api.appleMusicGetLastRequestDebug()`

### 4. Renderer Service: セッションAPI前提に切替

- ファイル: `src/service/apple-music.ts`
- 実装内容:
  - `appleMusicService.initialize()` は引数なしに変更
  - すべての Apple Music 操作が `window.api.appleMusicApiRequest(...)` 経由
  - `search / album / playlist / library` のマッピング実装あり
  - `isAuthorized` と `storefrontId` を service 内で管理

### 5. Settings UI: サインイン導線と接続確認

- ファイル: `src/app/components/settings/pages/content/apple-music.tsx`
- 実装内容:
  - 「Apple Music にサインイン」ボタンを追加
  - Initialize ボタンでセッション認証状態チェック
  - Account Library Check（songs/albums/playlists件数）
  - 401時は request debug を取得してトーストと画面に表示
  - 非Desktop時はサインイン不可の説明表示

### 6. Apple Music ページ: 初期化・検索・ブラウズ

- ファイル: `src/app/pages/apple-music/index.tsx`
- 実装内容:
  - 初回アクセス時に `appleMusicService.initialize()` 実行
  - 検索、アルバム詳細、プレイリスト詳細、選曲/再生導線を実装

---

## 削除済み（旧ロジック）

- 旧トークン取得実装ファイル:
  - `electron/main/core/apple-music-token-fetch.ts`（削除済み）
- 旧IPC/型参照:
  - `AppleMusicFetchTokens`
  - `appleMusicFetchTokens()`
  - `AppleMusicTokenResult`
  - 上記のコード参照は削除済み

---

## 手動確認結果（直近）

- サインイン経路: 成功
- コネクション確認: 成功
- ライブラリチェック: **Songs 25 / Albums 13 / Playlists 7** を取得
- 受け入れ手動チェックリスト: `docs/apple-music-acceptance-manual-checklist.md`

注: 上記は実運用確認の結果であり、CI 自動テストは未整備。

---

## 既知の注意点

1. `music.apple.com` 側の仕様変更に影響される可能性がある
2. サインイン状態や locale リダイレクト挙動によって、取得タイミングが不安定になる場合がある
3. 401 調査のためのデバッグ表示は暫定的に詳細寄り（運用方針に応じて縮小候補）

---

## 現時点の結論

Apple Music 連携は、**「トークン手入力/傍受」ではなく「BrowserWindow セッション実行」方式で動作する状態**に到達。  
旧トークン取得ロジックは削除済みで、現在の基準実装は新方式のみ。
