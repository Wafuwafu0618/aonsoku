# Apple Music UI統合 — 実装計画書

## 概要

Apple Musicの楽曲をaonsokuのUIで検索・閲覧・選曲できるようにし、再生ボタンを押したら`adamId`が再生バックエンドに渡せる状態にする。再生パイプライン（復号・デコード・リサンプル・出力）は別途実装のため、本計画には含まない。

---

## 前提: 現在のアーキテクチャ上の接続点

| 項目 | ファイル | 現在の定義 |
|---|---|---|
| メディアソース | `src/domain/media-source.ts` | `'navidrome' \| 'spotify' \| 'local'` |
| 再生バックエンドID | `src/domain/playback-backend.ts` | `'internal' \| 'native' \| 'spotify-connect' \| 'hqplayer' \| 'exclusive'` |
| トラック型 | `src/domain/entities/track.ts` | `MediaTrack { id, source, sourceId, playbackBackend, ... }` |
| バックエンドファクトリ | `src/playback/backends/song-backend-factory.ts` | `backendId`でディスパッチ |
| ロードリクエスト | `src/playback/session-types.ts` | `PlaybackLoadRequest { src, durationSeconds, ... }` |

---

## Phase 1: ドメイン層の拡張

### 1-1. MediaSourceに`'apple-music'`を追加

```diff
// src/domain/media-source.ts
-export const MEDIA_SOURCES = ['navidrome', 'spotify', 'local'] as const
+export const MEDIA_SOURCES = ['navidrome', 'spotify', 'local', 'apple-music'] as const
```

### 1-2. PlaybackBackendIdに`'apple-music'`を追加

```diff
// src/domain/playback-backend.ts
 export const PLAYBACK_BACKEND_IDS = [
   'internal',
   'native',
   'spotify-connect',
   'hqplayer',
   'exclusive',
+  'apple-music',
 ] as const
```

### 1-3. MediaTrackにApple Music固有フィールドを追加（任意）

```ts
// src/domain/entities/track.ts
export interface MediaTrack {
  // ... 既存フィールド ...
  adamId?: string          // Apple Musicの楽曲識別子
  appleMusicUrl?: string   // Apple Music上の楽曲URL
}
```

`adamId`はApple Musicで楽曲を一意に特定するために必須。これが再生パイプラインに渡される主キーになる。

---

## Phase 2: MusicKit JS統合

### 2-1. MusicKit JSの導入

`index.html`にMusicKit JSのスクリプトを追加：

```html
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js"
        data-web-components
        crossorigin></script>
```

### 2-2. MusicKit初期化サービス

`src/service/apple-music.ts` を新規作成：

```ts
// 最低限のインターフェース
interface AppleMusicService {
  initialize(developerToken: string, musicUserToken: string): Promise<void>
  isAuthorized(): boolean
  search(query: string, types: string[]): Promise<AppleMusicSearchResult>
  getCatalogAlbum(id: string): Promise<AppleMusicAlbum>
  getCatalogPlaylist(id: string): Promise<AppleMusicPlaylist>
  getLibrary(): Promise<AppleMusicLibraryResult>
}
```

**初期化に必要なトークン**:
- `developerToken` — Apple Developer Tokenに相当する値
- `musicUserToken` — Apple Musicサブスクリプションユーザーのトークン

これらの値はSettings画面から入力するか、外部プロセスから取得する形を想定。取得経路の実装は本計画の範囲外。

### 2-3. Apple Musicの型定義

`src/types/responses/apple-music.ts` を新規作成。MusicKit JSのレスポンスをアプリ内型にマッピングするための定義：

```ts
export interface AppleMusicSong {
  id: string           // MusicKit JS内部ID
  adamId: string       // Apple Musicの一意識別子（これが再生に必須）
  title: string
  artistName: string
  albumName: string
  durationMs: number
  artworkUrl: string
  trackNumber?: number
  discNumber?: number
  genreNames: string[]
  contentRating?: string
}

export interface AppleMusicAlbum {
  id: string
  name: string
  artistName: string
  artworkUrl: string
  trackCount: number
  releaseDate: string
  songs: AppleMusicSong[]
}

export interface AppleMusicSearchResult {
  songs: AppleMusicSong[]
  albums: AppleMusicAlbum[]
  playlists: AppleMusicPlaylist[]
}
```

### 2-4. ドメインマッパー

`src/domain/mappers/apple-music/index.ts` を新規作成。MusicKit JSのレスポンスから`MediaTrack`への変換：

```ts
function mapAppleMusicSongToMediaTrack(song: AppleMusicSong): MediaTrack {
  return {
    kind: 'track',
    id: `am-${song.adamId}`,
    source: 'apple-music',
    sourceId: song.adamId,
    playbackBackend: 'apple-music',
    title: song.title,
    albumTitle: song.albumName,
    primaryArtist: song.artistName,
    artists: [{ id: '', name: song.artistName }],
    durationSeconds: song.durationMs / 1000,
    coverArtId: song.artworkUrl,
    genreNames: song.genreNames,
    adamId: song.adamId,
  }
}
```

---

## Phase 3: UI構築

### 3-1. Apple Music設定ページ

`src/app/components/settings/pages/content/` 配下に設定UIを追加：
- トークン入力（developerToken / musicUserToken）
- 接続状態の表示
- アカウント情報の確認

### 3-2. Apple Musicブラウズ画面

既存のナビゲーション構造に沿って、Apple Musicセクションを追加：
- **検索**: テキスト検索 → MusicKit API `/v1/catalog/{storefront}/search`
- **アルバム詳細**: トラックリスト表示
- **プレイリスト表示**: ユーザーライブラリのプレイリスト

UIコンポーネントは既存のNavidrome用コンポーネントを参考に、同じデザイン言語で構築。

### 3-3. カバーアート表示

Apple Musicのアートワーク URLはテンプレート形式（`{w}x{h}`）なので、Naviromeのカバーアートコンポーネントとは異なるURL解決が必要：

```ts
function resolveAppleMusicArtworkUrl(
  template: string,
  width: number,
  height: number
): string {
  return template
    .replace('{w}', String(width))
    .replace('{h}', String(height))
}
```

---

## Phase 4: 再生バックエンド枠の準備

### 4-1. バックエンドファクトリにApple Music分岐を追加

```diff
// src/playback/backends/song-backend-factory.ts
+import { AppleMusicPlaybackBackend } from './apple-music-backend'

 export function createSongPlaybackBackend({
   audio, backendId, outputMode,
 }: SongPlaybackBackendFactoryInput): PlaybackBackend {
+  if (backendId === 'apple-music') {
+    return new AppleMusicPlaybackBackend({ outputMode })
+  }
   if (backendId === 'spotify-connect') {
     return new SpotifyConnectPlaybackBackend()
   }
   // ...
 }
```

### 4-2. AppleMusicPlaybackBackendのスタブ実装

`src/playback/backends/apple-music-backend.ts` を新規作成。最初はスタブとして、後から再生パイプラインを接続する：

```ts
export class AppleMusicPlaybackBackend implements PlaybackBackend {
  readonly id = 'apple-music' as PlaybackBackendId
  readonly capabilities = {
    canSeek: true,
    canSetVolume: true,
    emitsTimeUpdates: true,
  }

  async load(request: PlaybackLoadRequest): Promise<void> {
    // request.src には "apple-music://{adamId}" 形式のURIが入る想定
    // ここから先の復号・再生パイプラインは別途実装
    throw new Error('Apple Music playback pipeline is not yet implemented')
  }

  async play(): Promise<void> { /* TODO */ }
  pause(): void { /* TODO */ }
  seek(positionSeconds: number): void { /* TODO */ }
  setVolume(volume: number): void { /* TODO */ }
  getSnapshot(): PlaybackSnapshot { /* TODO: デフォルト値を返す */ }
  subscribe(listener: PlaybackSubscription): PlaybackUnsubscribe { return () => {} }
  dispose(): void { /* TODO */ }
}
```

### 4-3. `PlaybackLoadRequest.src`の形式

Apple Musicの楽曲を再生する際の`src`はカスタムURIスキーマを使う：

```
apple-music://{adamId}
```

例: `apple-music://1440818783`

これを受け取った再生バックエンドがadamIdを抽出し、再生パイプラインに渡す。

---

## ハンドオフ条件

以下が満たされていれば、再生パイプライン実装側に引き継ぎ可能：

1. ✅ UIで楽曲を選択 → `MediaTrack`に`adamId`が入っている
2. ✅ `createSongPlaybackBackend`で`apple-music`バックエンドが生成される
3. ✅ `AppleMusicPlaybackBackend.load()`に`apple-music://{adamId}`が渡される
4. ✅ MusicKit JSが初期化済みで、カタログ検索・メタデータ取得が動作する

---

## ファイル変更一覧

| 操作 | ファイル |
|------|---------|
| 修正 | `src/domain/media-source.ts` |
| 修正 | `src/domain/playback-backend.ts` |
| 修正 | `src/domain/entities/track.ts` |
| 修正 | `src/playback/backends/song-backend-factory.ts` |
| 修正 | `index.html` |
| 新規 | `src/service/apple-music.ts` |
| 新規 | `src/types/responses/apple-music.ts` |
| 新規 | `src/domain/mappers/apple-music/index.ts` |
| 新規 | `src/playback/backends/apple-music-backend.ts` |
| 新規 | `src/app/components/settings/pages/content/apple-music.tsx` |
| 新規 | Apple Musicブラウズ画面のコンポーネント群 |
