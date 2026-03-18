# WP3 ローカルライブラリ引き継ぎ（2026-03-19）

## 1. 現在の到達点

- フェーズ3は **WP3.5まで実装完了**。
- WP3.6（仮想スクロール）が未着手。
- 日本語専用運用（`ja`固定）への切り替えも完了。

## 2. 今回の実装内容（要点）

### 2.1 設定画面にローカルライブラリ管理を追加

- 追加: `src/app/components/settings/pages/content/local-library.tsx`
- 統合: `src/app/components/settings/pages/content/index.tsx`

機能:
- フォルダ追加（Explorer/Finderのディレクトリ選択ダイアログ）
- 登録フォルダ一覧表示
- 各フォルダの削除
- 手動スキャン開始（ユーザー指定どおり自動開始はしない）
- スキャン進捗・統計・最終スキャン時刻の表示

### 2.2 ローカルライブラリ状態ストア追加

- 追加: `src/store/local-library.store.ts`

保持内容:
- `directories`
- `isScanning`
- `progress`
- `lastScanAt`

### 2.3 Electron IPCを追加（ローカルファイル操作）

- 更新: `electron/preload/types.ts`
- 更新: `electron/preload/index.ts`
- 更新: `electron/main/core/events.ts`

追加API:
- `pickLocalLibraryDirectory`
- `listLocalLibraryFiles`
- `readLocalLibraryFile`

### 2.4 Renderer側アダプタ追加

- 追加: `src/platform/adapters/local-library-adapter.ts`
- 更新: `src/platform/contracts/desktop-contract.ts`
- 更新: `src/platform/index.ts`

### 2.5 スキャンの実データ接続

- 更新: `src/local-library/scanner.ts`

処理フロー:
1. 登録フォルダから音楽ファイルを再帰列挙
2. ファイル読み込み
3. Workerでメタデータ抽出
4. `tracks` をIndexedDBへ保存
5. 検索インデックス再構築
6. 最終スキャン時刻更新

### 2.6 Sourceフィルタとローカル再生

- 追加: `src/app/components/search/source-filter.tsx`
- 更新: `src/app/pages/songs/songlist.tsx`
- 更新: `src/queries/songs.ts`
- 更新: `src/utils/albumsFilter.ts`
- 更新: `src/app/components/player/player.tsx`

内容:
- Songs画面で `All/Navidrome/Local` フィルタ
- `local` の場合はIndexedDBから曲を取得
- ローカル曲再生は `file:///` URLで再生

## 3. 日本語運用の変更

- 追加: `src/i18n/locales/ja.json`
- 更新: `src/i18n/index.ts`
- 更新: `src/i18n/languages.ts`
- 更新: `src/utils/dateTime.ts`
- 更新: `src/app/components/login/form.tsx`
- 更新: `src/app/components/settings/options.tsx`
- 更新: `src/store/lang.store.ts`
- 更新: `src/app/observers/lang-observer.tsx`

結果:
- UI言語を日本語固定
- 言語切替UIは実質的に撤去

## 4. ビルド/実行メモ

### 4.1 実行済み検証

- `npm run build -- --emptyOutDir false` : OK
- `npm run electron:build` : OK

### 4.2 `build:unpack` で遭遇した問題

症状:
- `rcedit-x64.exe` の `Fatal error: Unable to commit changes`

切り分け結果:
- 管理者権限でも再現
- ただし **別ディレクトリにリポジトリを置くと解消**

備考:
- 実装不具合というよりWindows環境/保護機構起因の可能性が高い

## 5. 次に他ツールが進めるべき作業

優先順:
1. WP3.6（Songs/Albums/Artistsの仮想スクロール）
2. ローカル曲のメタ情報マッピング精度向上（`ISong`互換項目の補完）
3. フォルダ削除時の差分削除（現在は次回スキャンで全再構築）
4. スキャンの増分更新最適化（mtime比較で再解析を最小化）
5. エラーハンドリング改善（読み取り不能ファイルのUI表示改善）

## 6. 注意事項（引き継ぎ先向け）

- この作業ブランチは既存変更が多く、ワークツリーがdirtyな前提。
- `src/app/components/settings/local-library/scan-dashboard.tsx` は旧実装のため削除済み方針（新しい設定画面実装へ統合）。
- 既存の `docs/wp3.5-debug-requirements.md` は初期案を含むため、本ドキュメントの状態を優先。
