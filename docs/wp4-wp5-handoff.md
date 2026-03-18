# WP4 → WP5 引き継ぎドキュメント

## 1. 現在の状態サマリー

### WP1〜WP4 完了状況
- **WP1**: Play/Pause/Stop/Seek等の基本再生操作をplayback-command-controller.tsへ分離完了
- **WP2**: 歌詞同期・シークのaudio依存をstore actionへ集約完了
- **WP3**: 同期処理をplayback-session-bridge.tsへ分離完了
- **WP4**: Navidrome再生のキューと操作経路を新基盤へ移行完了

### 主要な変更ファイル（WP4完了時点）
- `src/store/playback-session-bridge.ts` - 同期処理ブリッジ（新規）
- `src/store/playback-session.store.ts` - 再生状態管理（新規）
- `src/store/playback-command-controller.ts` - 再生コマンドコントローラ（新規）
- `src/store/player.store.ts` - プレイヤーメインストア（既存）

### 通過済み検証
- `npm run lint` - OK
- `npm run build -- --emptyOutDir false` - OK
- `npm run test -- --spec src/app/components/player/player.cy.tsx` - OK

---

## 2. WP5の実装方針（確定事項）

### 2.1 Source Badge
- **目的**: 音楽ソース（Navidrome/Spotify/Local）を視覚的に識別
- **実装**: スタイル切替対応（3パターン）
  - `navidrome`: 特定のスタイル
  - `spotify`: 特定のスタイル
  - `local`: 特定のスタイル

### 2.2 Queue型移行
- **方針**: 完全移行（songのみ）
- **内容**:
  - `ISong` → `QueueItem` 型置き換え
  - `currentList` は残すが、UIから直接参照しない
  - QueueItem拡張（source情報追加）

### 2.3 Radio/Podcast
- **方針**: 現状維持
- **詳細**: source化しない（将来的な拡張用に領域は確保）

### 2.4 互換性
- **方針**: adapter層で一元管理
- **詳細**: `src/store/queue-adapter.ts` 新規作成

---

## 3. 実装ステップ

### Step 1: songのみQueueItem完全移行
- `currentList` は残すが、UIから直接参照しない
- QueueItem型定義の追加

### Step 2: UIコンポーネント更新
- `src/app/tables/queue-columns.tsx`
- `src/app/components/queue/song-list.tsx`

### Step 3: src/store/queue-adapter.ts新規作成
- `ISong` → `QueueItem` 変換関数
- QueueItem定義

### Step 4: SourceBadgeコンポーネント作成
- `src/app/components/source-badge.tsx` 新規作成
- スタイル3パターン対応

### Step 5: Player現在曲表示へのsource情報追加
- `src/app/components/player/track-info.tsx`
- `src/app/components/queue/current-song-info.tsx`

---

## 4. 変更対象ファイルリスト

### 修正予定ファイル
1. `src/app/components/queue/song-list.tsx`
2. `src/app/components/queue/current-song-info.tsx`
3. `src/app/tables/queue-columns.tsx`
4. `src/app/components/table/song-title.tsx`
5. `src/app/components/player/track-info.tsx`

### 新規作成ファイル
1. `src/app/components/source-badge.tsx`
2. `src/store/queue-adapter.ts`

---

## 5. 検証手順

### 5.1 Lint
```bash
npm run lint
```

### 5.2 Build
```bash
npm run build -- --emptyOutDir false
```

### 5.3 Test
```bash
npm run test -- --spec src/app/components/player/player.cy.tsx
```

---

## 6. 注意点・制約

### 6.1 Radio/Podcast
- **触らない**: radio/podcast関連は変更しない

### 6.2 テスト
- **必須**: 既存の `player.cy.tsx` テストは必ず通す

### 6.3 コミット
- **タグ必須**: コミットメッセージに `(kimi k2.5)` タグを付ける

### 6.4 型定義
- **ISong**: 現在の定義は `src/types/responses/song.ts` で管理
- **QueueItem**: 新規型定義を `src/types/queue.ts` で作成（推奨）

---

## 7. 現在の主要ファイル構造

### Player Store
- `src/store/player.store.ts` (1128行)
  - songlist: ISongList
    - shuffledList: ISong[]
    - currentList: ISong[]
    - currentSong: ISong
    - originalList: ISong[]
    - radioList: Radio[]
    - podcastList: EpisodeWithPodcast[]
  - playerState: IPlayerState
  - actions: IPlayerActions

### 型定義
- `src/types/playerContext.ts` - ISongList, IPlayerContext
- `src/types/responses/song.ts` - ISong

### UIコンポーネント
- `src/app/components/player/track-info.tsx` (160行)
- `src/app/components/queue/current-song-info.tsx` (100行)
- `src/app/tables/queue-columns.tsx` (126行)
- `src/app/components/table/song-title.tsx` (92行)

---

## 8. 付録

### 8.1 最新のGitログ
```
8c6c8d1 refactor(wp4): Navidrome再生のキューと操作経路を新基盤へ移行
d7da444 refactor(player): シークと歌詞同期のaudio依存をstore actionへ集約
e3a7678 refactor(playback-session): 同期処理をbridgeへ分離
9484063 refactor(player-controller): 副作用サブスクリプションを分離
8d00b48 refactor(playback-session): 再生状態の参照を専用storeへ段階移行
7c4be4a refactor(player-ui): drawer/fullscreen状態を専用storeへ分離
c739581 feat(playback): song再生をinternal backend経由に統一
330ab88 test(player): キューのnext/prev遷移の回帰テストを追加
aad25f0 feat(domain): source対応のエンティティとNavidromeマッパーを追加
c334d3e docs: 土台フェーズの計画と引き継ぎ資料を追加
```

### 8.2 作業ブランチ
- 作業ブランチ: 未作成（適宜作成）

---

---

## 9. WP5進捗状況（更新: 2025年3月18日）

### 9.1 完了した作業

#### Step 1-4完了
- ✅ `src/store/queue-adapter.ts` 新規作成
  - `ISong` → `QueueItem` 変換関数
  - ソース別スタイル定義（navidrome/spotify/local）
  
- ✅ `src/app/components/source-badge.tsx` 新規作成
  - SourceBadgeコンポーネント（ラベル表示版）
  - SourceBadgeDotコンポーネント（ドットのみ版）
  - 3ソース対応のスタイル定義

- ✅ `src/app/components/queue/song-list.tsx` 更新
  - `usePlaybackQueueState()` 導入
  - `displayList` / `displayIndex` によるQueueItem優先表示
  - `currentList` はフォールバックとして維持

- ✅ `src/app/tables/queue-columns.tsx` 更新
  - `ColumnDefType<QueueItem | ISong>` 対応
  - `extractDisplayInfo()` / `extractArtistInfo()` ヘルパー追加
  - SourceBadge表示（タイトル列）
  - QueueItemとISongの両対応

### 9.2 検証結果
```
✅ npm run lint - OK
✅ npm run build -- --emptyOutDir false - OK  
✅ npm run test -- --spec src/app/components/player/player.cy.tsx - 9 passing
```

### 9.3 コミット履歴
```
ce576c1 feat(wp5): Queue表示のsource-aware化とSourceBadge追加 (kimi k2.5)
```

### 9.4 残タスク

#### Step 5: Player現在曲表示へのsource情報追加（未着手）
- `src/app/components/player/track-info.tsx`
  - 現在曲のsourceバッジ表示
- `src/app/components/queue/current-song-info.tsx`
  - キュー内現在曲のsource表示

#### 補足
- radio/podcastは現状維持（source化しない）
- QueueItemはsongのみで使用、radio/podcastはISongのまま

---

---

## 10. WP5完了報告（2025年3月18日）

### 10.1 全ステップ完了

#### ✅ Step 5: Player現在曲とQueue現在曲のsource表示
- `src/app/components/player/track-info.tsx`
  - `usePlaybackQueueState`導入
  - アーティスト名の横にSourceBadge（ドット版）を追加
  - songのみ表示、radio/podcastは非表示

- `src/app/components/queue/current-song-info.tsx`
  - `usePlaybackQueueState`導入
  - アーティストリンクの下にSourceBadge（ラベル版）を追加
  - 中央揃えで表示

### 10.2 WP5最終検証結果
```
✅ npm run lint - OK
✅ npm run build -- --emptyOutDir false - OK
✅ npm run test -- --spec src/app/components/player/player.cy.tsx - 9 passing
```

### 10.3 WP5全コミット履歴
```
a355fde feat(wp5): Player現在曲とQueue現在曲にsourceバッジ表示を追加 (kimi k2.5)
ce576c1 feat(wp5): Queue表示のsource-aware化とSourceBadge追加 (kimi k2.5)
ab28b1a docs: WP5進捗を引き継ぎドキュメントに追記 (kimi k2.5)
```

### 10.4 WP5作成/変更ファイル一覧

#### 新規作成ファイル
1. ✅ `src/store/queue-adapter.ts` - ISong→QueueItem変換アダプタ
2. ✅ `src/app/components/source-badge.tsx` - SourceBadgeコンポーネント

#### 変更ファイル
3. ✅ `src/app/components/queue/song-list.tsx` - QueueItem対応
4. ✅ `src/app/tables/queue-columns.tsx` - QueueItem/ISong両対応 + SourceBadge
5. ✅ `src/app/components/player/track-info.tsx` - sourceバッジ追加
6. ✅ `src/app/components/queue/current-song-info.tsx` - sourceバッジ追加

### 10.5 実装詳細

#### Source Badge表示位置
- **Player（track-info）**: アーティスト名の横（小さめドット版）
- **Queue（current-song-info）**: アーティストリンクの下（ラベル付き版）
- **Queue一覧**: タイトルの横（ドット版）

#### 対応ソース
- `navidrome`: インディゴ色（#4F46E5）
- `spotify`: グリーン（#1DB954）
- `local`: バイオレット（#7C3AED）

#### 非対応（現状維持）
- radio: sourceバッジ非表示
- podcast: sourceバッジ非表示

### 10.6 次のフェーズ（WP6）への移行条件
WP5が完了したため、以下の条件を満たしています：
- ✅ アプリがtrackのsource metadataを表示できる
- ✅ sourceの扱いがNavidrome専用前提になっていない
- ✅ 将来Spotifyやlocal trackを追加してもqueue modelを作り直さずに済む

**WP6準備完了**

---

*このドキュメントはWP5完了時点で最終更新されました。WP6以降の作業は別途ドキュメントを作成してください。*
