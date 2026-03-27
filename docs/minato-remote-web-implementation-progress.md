# Minato Remote Web - React化実装進捗

## 実装済み

### Phase 0: 基本構造
- [x] `vite.remote.config.ts` - Remote Web専用ビルド設定
- [x] `src/remote-web/` - Reactアプリ構成
  - `index.html` - エントリーポイント
  - `main.tsx` - Reactマウント
  - `App.tsx` - メインアプリ（接続画面、タブナビゲーション）
  - `hooks/useRemoteSession.ts` - セッション管理
  - `hooks/useRemoteState.ts` - SSE状態購読
  - `hooks/useRemoteCommands.ts` - コマンド送信
  - `lib/remoteApi.ts` - APIクライアント
  - `styles/remote.css` - モバイル向けスタイル
  - `pages/library/LibraryPage.tsx` - Library画面（Navidrome連携）

### Phase 1: MainプロセスAPI拡張
- [x] `IpcChannels`拡張 - Library API用チャネル追加
- [x] `remote-relay-manager.ts`拡張
  - Library APIエンドポイント追加（/api/remote/library/*）
  - Rendererプロセス連携仕組み（`fetchFromRenderer`）
  - カバーアート配信エンドポイント

## 残タスク

### Phase 2: Rendererプロセス連携
Renderer側（Minato Desktop本体）に以下を実装する必要があります：

```typescript
// src/remote-library-handler.ts（新規作成）
// Mainプロセスからのイベントを受信してNavidrome APIを呼び出す

ipcRenderer.on('remote-library-request', async (event, { requestId, channel, data }) => {
  let result
  switch (channel) {
    case 'get-artists':
      result = await subsonic.artists.getAll()
      break
    case 'get-albums':
      result = await subsonic.albums.getAlbumList({ ... })
      break
    case 'get-songs':
      result = await subsonic.songs.getAll({ ... })
      break
    case 'search':
      result = await subsonic.search.get({ ... })
      break
    case 'get-cover-art':
      result = await fetchCoverArt(data.coverArtId)
      break
  }
  
  ipcRenderer.send('remote-library-response', { requestId, data: result })
})
```

### Phase 3: ビルド・統合
```bash
# Remote Webビルド
npx vite build --config vite.remote.config.ts

# 出力: electron/main/core/remote-web-dist/
# remote-relay-manager.tsの静的ファイル配信を修正して、
# ビルド済みファイルを配信するように変更
```

## 次のアクション

1. Renderer側イベントハンドラーを実装
2. ビルドスクリプトをpackage.jsonに追加
3. remote-relay-manager.tsの配信ロジックを修正（ビルド済みReactアプリを配信）
4. テスト（Cloudflare Tunnel経由でモバイルからアクセス）

現状のHTML埋め込みをReactに置き換えるには、`buildRemoteWebHtml()`メソッドを修正し、ビルド済みファイルを読み込むように変更する必要があります。
