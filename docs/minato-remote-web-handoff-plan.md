# Minato Remote Web - 実装引継ぎ計画書

**作成日**: 2026-03-26  
**作成者**: Claude (AI Assistant)  
**引継ぎ先**: 開発者

---

## 現在の状況

### 完了したもの

#### Phase 0: 基本構造
- ✅ `vite.remote.config.ts` - Remote Web専用ビルド設定
- ✅ `src/remote-web/` - Reactアプリ構成
  - `index.html` - エントリーポイント
  - `main.tsx` - Reactマウント
  - `App.tsx` - メインアプリ（接続画面、タブナビゲーション）
  - `styles/remote.css` - モバイル向けスタイル

#### Phase 1: Library機能
- ✅ `pages/library/LibraryPage.tsx` - Library画面（検索、アーティスト/アルバム/曲表示）
- ✅ `hooks/useRemoteSession.ts` - セッション管理
- ✅ `hooks/useRemoteState.ts` - SSE状態購読
- ✅ `hooks/useRemoteCommands.ts` - コマンド送信
- ✅ `lib/remoteApi.ts` - APIクライアント

#### Phase 2: Mainプロセス連携
- ✅ `electron/preload/types.ts` - IPCチャネル追加（RemoteLibraryRequest/Response）
- ✅ `electron/preload/index.ts` - API追加（remoteLibraryRequestListener等）
- ✅ `electron/main/core/remote-relay-manager.ts` - Library APIエンドポイント追加
- ✅ `src/remote-library-handler.ts` - Renderer側イベントハンドラー
- ✅ `src/App.tsx` - ハンドラー初期化

#### Phase 3: ビルド・配信
- ✅ `package.json` - `build:remote-web`スクリプト追加
- ✅ 静的ファイル配信ロジック修正（複数候補探索対応）

### 現在の問題

**アルバムが表示されない**
- React UIは正しく表示される
- セッション取得は成功
- APIリクエストは到達するが、レスポンスが空（またはエラー）

---

## 残りのタスク

### 優先度: 高

#### 1. Library APIのデバッグ・修正
**問題**: `/api/remote/library/albums` などのエンドポイントが空配列を返す

**確認すべきポイント**:
- `fetchFromRenderer` が正しくRendererにリクエストを送信しているか
- `remote-library-handler.ts` のハンドラーが正しくNavidrome APIを呼び出しているか
- Navidrome APIからのレスポンスが正しくRemote Webに返っているか

**デバッグ手順**:
1. ElectronアプリのConsoleで `[RemoteRelay]` ログを確認
2. Renderer側（Minato Desktop）のConsoleで `[RemoteLibrary]` ログを確認
3. `subsonic.artists.getAll()` などが正しく動作するか確認

**関連ファイル**:
- `electron/main/core/remote-relay-manager.ts` (line 2420-2460)
- `src/remote-library-handler.ts`

#### 2. カバーアート取得の実装
**問題**: `handleGetCoverArt` が未実装（または動作しない）

**現在のコードの問題**:
```typescript
// remote-library-handler.ts
const base64 = Buffer.from(arrayBuffer).toString('base64')  // Bufferはブラウザで使えない
```

**修正案**:
- ArrayBufferを直接Base64に変換する方法を使用
- または、btoa/atobを使用

#### 3. 型エラーの修正
**LSPエラーの一覧**:
- `electron/main/core/remote-relay-manager.ts` - IpcChannels型の不一致
- `electron/main/core/events.ts` - 削除したハンドラーの参照残り
- `src/remote-web/hooks/*.ts` - remoteApiのインポート形式
- `src/remote-library-handler.ts` - 型インポートエラー

### 優先度: 中

#### 4. Queueページ（Phase 2）
**要件**:
- 現在の再生キューを表示
- キュー内の曲をタップで再生
- 曲の削除（将来的に）

**使用するコンポーネント**:
- `src/app/components/queue/song-list.tsx` - 本体のキューリストを流用

#### 5. Playerページ（Phase 3）
**要件**:
- 現在再生中の曲情報（大きなアートワーク）
- 再生コントロール（Play/Pause/Prev/Next）
- シークバー
- 音量調整

**使用するコンポーネント**:
- `src/app/components/player/track-info.tsx`
- `src/app/components/player/controls.tsx`
- `src/app/components/player/progress.tsx`
- `src/app/components/player/volume.tsx`

### 優先度: 低

#### 6. 曲の再生機能
**要件**:
- Library/Queueから曲をタップして再生
- Web Audio APIまたはWebSocket PCMで音声出力

**技術的検討事項**:
- 現在はPCMストリーミングのみ実装済み
- HLSフォールバックは将来対応

#### 7. UI改善
- ダーク/ライトテーマ対応
- アニメーション追加
- ローディング状態の改善

---

## 技術的メモ

### アーキテクチャ
```
Remote Web (React) → Mainプロセス → Rendererプロセス → Navidrome API
     ↑                      ↓              ↓
     └────── JSONレスポース ← IPC ←── subsonicクライアント
```

### 重要なファイルのパス
- **Remote Webビルド出力**: `electron/main/core/remote-web-dist/`
- **配信される場所**: `out/main/remote-web-dist/` (electron-viteビルド時)
- **TypeScriptエイリアス**: `@/` → `src/`

### IPC通信の流れ
1. **Remote Web** → HTTP → **Main** (`handleLibraryAlbums`)
2. **Main** → IPC `RemoteLibraryRequest` → **Renderer**
3. **Renderer** (`remote-library-handler.ts`) → Navidrome API
4. **Renderer** → IPC `RemoteLibraryResponse` → **Main**
5. **Main** → HTTP Response → **Remote Web**

---

## ビルド・テスト手順

```bash
# 1. Remote Webビルド
npm run build:remote-web

# 2. Electronアプリ起動
npm run electron:dev

# 3. ブラウザでアクセス
http://127.0.0.1:39096
# または Cloudflare Tunnel経由
```

---

## 参考リンク

- 計画書: `docs/minato-remote-web-frontend-plan-20260326.md`
- 実装進捗: `docs/minato-remote-web-implementation-progress.md`
- Navidrome API: `src/service/subsonic.ts`

---

## 連絡先

問題があれば、Claudeに再度質問してください。
