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

### 2.7 AlbumsのSourceフィルタとローカルアルバム再生

- 更新: `src/queries/albums.ts`
- 更新: `src/app/pages/albums/list.model.tsx`
- 更新: `src/app/components/albums/filters.tsx`
- 更新: `src/app/pages/albums/album.tsx`
- 更新: `src/app/hooks/use-album.tsx`
- 更新: `src/app/components/albums/album-grid-card.tsx`
- 更新: `src/app/components/home/preview-list.tsx`
- 更新: `src/app/components/album/buttons.tsx`
- 追加: `src/local-library/mappers/subsonic.ts`

内容:
- Albums画面で `All/Navidrome/Local` フィルタ
- `local-album:*` を扱えるアルバム取得処理を追加
- ローカルアルバム詳細ページで再生可能
- ローカルアルバムでNavidrome専用操作（Like/Optionsなど）を抑制

### 2.8 ArtistsのSourceフィルタとローカルアーティスト再生

- 追加: `src/queries/artists.ts`
- 更新: `src/app/hooks/use-artist.tsx`
- 更新: `src/app/pages/artists/list.tsx`
- 更新: `src/app/pages/artists/artist.tsx`
- 更新: `src/app/components/artist/buttons.tsx`
- 更新: `src/app/components/artist/artist-top-songs.tsx`
- 更新: `src/app/components/artist/artist-grid-card.tsx`
- 更新: `src/app/components/artist/options.tsx`
- 更新: `src/app/components/artist/related-artists.tsx`
- 更新: `src/app/components/command/artist-result.tsx`
- 更新: `src/queries/songs.ts`
- 更新: `src/queries/albums.ts`

内容:
- Artists画面で `All/Navidrome/Local` フィルタ
- `local-artist:*` の一覧/詳細/Top Songs を取得可能に変更
- ローカルアーティスト詳細でNavidrome依存表示（関連アーティスト/Like/Options）を抑制
- アーティスト再生導線を `artist.id` ベースに統一し、ローカルIDでもキュー再生可能

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
1. WP3.5アルバム/アーティスト対応の手動デバッグ完了（`/albums` `/artists` 一覧・詳細・再生・Source切替）
2. Albums/Artistsの回帰テスト追加（少なくとも query層 + 画面操作の自動テスト）
3. WP3.6（Songs/Albums/Artistsの仮想スクロール）
4. ローカル曲/アルバム/アーティストのメタ情報マッピング精度向上（`ISong`互換項目の補完）
5. スキャンの増分更新最適化とエラーハンドリング改善（差分削除含む）
6. 上記完了後、フェーズ5「Aonsoku内蔵オーバーサンプラー/GPU」へ着手（先行でCPU実装、その後GPU）

## 6. 注意事項（引き継ぎ先向け）

- この作業ブランチは既存変更が多く、ワークツリーがdirtyな前提。
- `src/app/components/settings/local-library/scan-dashboard.tsx` は旧実装のため削除済み方針（新しい設定画面実装へ統合）。
- 既存の `docs/wp3.5-debug-requirements.md` は初期案を含むため、本ドキュメントの状態を優先。

---

## 7. 追記（2026-03-19 / WP3.6前倒し対応）

今回の更新で、巨大ライブラリ時のSongs表示負荷を下げるため、次を実施:

- `src/local-library/repository.ts`
  - `getTracksPage` / `getTracksCount` を追加
  - `searchTracksPage` / `searchTracksCount` を追加
  - `searchTracks` は内部的にページング版を利用する構成へ変更
- `src/queries/songs.ts`
  - `source=local` / `source=all` で全件読み込みを行わないページング処理に変更
  - `source=all` は Navidrome 件数 + Local 件数を使って offset を正しく解決
  - `LocalTrack -> ISong` 変換を拡張し、必須フィールド補完と型安全性を強化
- `src/app/pages/songs/songlist.tsx`
  - sourceフィルタ利用時の件数表示を `totalCount` 優先へ変更

副次対応:

- `src/domain/mappers/navidrome/index.ts`
  - `song.id` から `local/spotify/navidrome` を判別し、QueueItemのsourceを正しく反映
- `src/api/httpClient.ts`
  - coverArtが `data:` / `file:` / `http(s):` の直接URLの場合は `getCoverArt` を経由しないよう改善

## 8. 追記（2026-03-19 / Albums Source対応）

今回の更新で、ローカルライブラリをAlbums画面にも統合:

- `src/queries/albums.ts`
  - `source=navidrome|local|all` で一覧/検索/ディスコグラフィ取得を切替
  - `local-album:*` でローカルアルバム詳細を返す `getAlbumById` を追加
  - ローカルアルバムの集約（曲->アルバム）とページングを実装
- `src/app/pages/albums/list.model.tsx`
  - Sourceパラメータをクエリキー/取得処理へ反映
- `src/app/pages/albums/album.tsx`
  - ローカルアルバム時の関連取得を抑制し、再生主体の表示へ切替
- `src/app/components/album/buttons.tsx`
  - ローカルアルバムではLike/Optionsを非表示化

実行済み確認:

- `npm run lint` : OK
- `npm run build -- --emptyOutDir false` : OK
- `npm run test -- --spec src/app/components/player/player.cy.tsx` : OK

## 9. 次段階への移行条件（オーバーサンプリング着手ゲート）

- `Songs / Albums / Artists` で `source=local|all` が安定している
- ローカル曲/ローカルアルバム再生でキュー遷移が安定している
- `docs/wp3.5-manual-debug-checklist.md`（Albums追加項目含む）が完了している
- `lint` / `build` / 既存Cypress回帰が通っている
