# Apple Music トークン自動取得機構の実装計画

## 概要

Apple Developer Program（有料）に加入せずに Apple Music API を利用するため、**Electron の `BrowserWindow` で `music.apple.com` を開き、発生するネットワークリクエストのヘッダーから `Developer Token` と `Music User Token` を自動的に傍受・抽出する**仕組みを実装する。

ユーザーは設定画面の「Apple Musicにサインイン」ボタンを押すだけで、ログインウィンドウが開き、Apple ID でログイン完了後にトークンが自動取得される。

---

## アーキテクチャ

```
Renderer (設定UI)
  │
  │ appleMusicFetchTokens()
  ▼
Preload (IPC)
  │
  │ IPC: apple-music-fetch-tokens
  ▼
Main Process
  │
  │ new BrowserWindow → music.apple.com
  ▼
BrowserWindow (music.apple.com)
  │
  │ onBeforeSendHeaders で Authorization / Media-User-Token を傍受
  ▼
Main Process
  │ ウィンドウを閉じる
  │ { developerToken, musicUserToken } を返却
  ▼
Preload → Renderer
  │ トークンを受け取り、自動で appleMusicService.initialize() を呼ぶ
```

---

## 前提: 現在のアーキテクチャ上の接続点

| 項目 | ファイル | 説明 |
|---|---|---|
| Apple Music サービス | `src/service/apple-music.ts` | MusicKit JS の初期化・検索・ブラウズ |
| Apple Music 設定UI | `src/app/components/settings/pages/content/apple-music.tsx` | トークン入力・接続状態表示 |
| IPC チャネル定義 | `electron/preload/types.ts` | `IpcChannels` enum, `IAonsokuAPI` |
| IPC Preload 実装 | `electron/preload/index.ts` | Renderer → Main のブリッジ |
| IPC Main 実装 | `electron/main/core/events.ts` | Main 側のハンドラ登録 |

---

## 注意事項

> **重要**: この機構は Apple の公式 API トークン発行フローではなく、Web版 Apple Music のリクエストヘッダーからトークンを傍受する非公式な手法です。Apple 側の仕様変更により動作しなくなる可能性があります。

> **注意**: 取得したトークンには有効期限があります（Developer Token は通常数ヶ月、Music User Token はセッション依存）。期限切れ時は手動で再度サインインボタンを押す運用とします。

---

## Phase 1: トークン取得コアロジック（Electron Main Process）

### 1-1. `apple-music-token-fetch.ts` を新規作成

`electron/main/core/apple-music-token-fetch.ts` を新規作成。

**主要な処理フロー：**

1. `BrowserWindow` を `partition` 付きで生成（メインウィンドウのセッションを汚さない）
2. `music.apple.com` をロード
3. `session.webRequest.onBeforeSendHeaders` でリクエストヘッダーを監視
4. `Authorization: Bearer eyJ...` ヘッダーから Developer Token を抽出
5. `Media-User-Token` ヘッダーから Music User Token を抽出
6. 両方取得できたらウィンドウを閉じ、トークンを返却
7. タイムアウト（5分）も設ける

```ts
export interface AppleMusicTokenResult {
  ok: boolean
  developerToken?: string
  musicUserToken?: string
  error?: { code: string; message: string }
}

export async function fetchAppleMusicTokens(): Promise<AppleMusicTokenResult>
```

**実装のポイント:**

- `partition: 'persist:apple-music-auth'` を使い、ログイン状態を永続化（再ログインの頻度を下げる）
- `webRequest.onBeforeSendHeaders` のフィルタを `{ urls: ['https://amp-api.music.apple.com/*', 'https://api.music.apple.com/*'] }` に限定
- `Authorization` ヘッダーの値が `Bearer eyJ` で始まるものを Developer Token として抽出
- `Media-User-Token` ヘッダーの値を Music User Token として抽出
- 両方取得完了、またはウィンドウが閉じられた場合に Promise を resolve
- 5分のタイムアウトで自動失敗

---

## Phase 2: IPC 層の拡張

### 2-1. `IpcChannels` に新チャネルを追加

```diff
// electron/preload/types.ts
 export enum IpcChannels {
   // ... 既存チャネル ...
   AppleMusicSetWrapperConfig = 'apple-music-set-wrapper-config',
+  AppleMusicFetchTokens = 'apple-music-fetch-tokens',
 }
```

### 2-2. `AppleMusicTokenResult` 型を追加

```ts
// electron/preload/types.ts
export interface AppleMusicTokenResult {
  ok: boolean
  developerToken?: string
  musicUserToken?: string
  error?: { code: string; message: string }
}
```

### 2-3. `IAonsokuAPI` にメソッドを追加

```diff
// electron/preload/types.ts
 export interface IAonsokuAPI {
   // ... 既存メソッド ...
   appleMusicSetWrapperConfig: (config: AppleMusicWrapperConfig) => Promise<void>
+  appleMusicFetchTokens: () => Promise<AppleMusicTokenResult>
 }
```

### 2-4. Preload に実装を追加

```diff
// electron/preload/index.ts
 const api: IAonsokuAPI = {
   // ... 既存メソッド ...
   appleMusicSetWrapperConfig: (config: AppleMusicWrapperConfig) =>
     ipcRenderer.invoke(IpcChannels.AppleMusicSetWrapperConfig, config),
+  appleMusicFetchTokens: () =>
+    ipcRenderer.invoke(IpcChannels.AppleMusicFetchTokens),
 }
```

### 2-5. Main Process にハンドラを追加

```diff
// electron/main/core/events.ts
+import { fetchAppleMusicTokens } from './apple-music-token-fetch'

 // setupIpcEvents 内に追加:
+  ipcMain.removeHandler(IpcChannels.AppleMusicFetchTokens)
+  ipcMain.handle(IpcChannels.AppleMusicFetchTokens, () => fetchAppleMusicTokens())
```

---

## Phase 3: 設定UIの改修

### 3-1. 「サインイン」ボタンの追加

`src/app/components/settings/pages/content/apple-music.tsx` を修正。

- 既存のトークン手動入力欄の上に「Apple Music にサインイン」ボタンを追加
- ボタンクリック → `window.api.appleMusicFetchTokens()` → 取得したトークンを state に設定
- トークン取得成功後、自動で `appleMusicService.initialize()` を実行
- ボタンのラベルは処理中は「サインイン中...」に変更
- 既存の手動入力欄はフォールバック用にそのまま残す

---

## ファイル変更一覧

| 操作 | ファイル |
|------|---------|
| 新規 | `electron/main/core/apple-music-token-fetch.ts` |
| 修正 | `electron/preload/types.ts` |
| 修正 | `electron/preload/index.ts` |
| 修正 | `electron/main/core/events.ts` |
| 修正 | `src/app/components/settings/pages/content/apple-music.tsx` |

---

## 検証方法

### 手動検証

1. `npm run dev`（または同等のコマンド）でアプリを起動
2. Settings → Apple Music セクションを開く
3. 「Apple Music にサインイン」ボタンが表示されていることを確認
4. ボタンをクリックし、ポップアップウィンドウで `music.apple.com` が開くことを確認
5. Apple ID でログインし、トークンが自動取得されることを確認（Developer Token / Music User Token の入力欄に値が自動設定される）
6. Connection 欄が「Authorized」になることを確認

> **Note**: この機能は Apple ID でのログインが必要なため、CIでの自動テストは困難です。手動での確認を推奨します。
