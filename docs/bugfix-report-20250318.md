# バグ修正報告: 2曲目以降の再生が開始されない問題

## 発見日
2025年3月18日

## 発見者
開発者（ユーザー報告）

## バグの概要
アルバムの1曲目は正常に再生できるが、2曲目以降を選択しても再生が開始されない。
自動遷移（1曲目終了時）も同様に動作しない。

## 再現手順
1. アルバムまたはプレイリストから1曲目を選択して再生
2. 2曲目を手動で選択、または1曲目を最後まで再生して自動遷移
3. 再生ボタンは⏸（停止中）表示になるが、実際には音が出ない

## 原因分析

### 根本原因
`src/app/components/player/audio.tsx` の `useEffect` において、曲（src）が変更された際の `backend.load()` 呼び出しで `autoplay: false` が固定値で指定されていた。

### 詳細なメカニズム

```
1曲目再生中の状態:
  - isPlaying = true
  - src = "song1.mp3"

2曲目を選択:
  ↓
  src が "song2.mp3" に変更
  ↓
  useEffect が発火
  ↓
  backend.load({ src: "song2.mp3", autoplay: false }) ← ここが問題
  ↓
  isPlaying は true のまま（変更なし）
  ↓
  isPlaying 変更を監視する useEffect は発火しない
  ↓
  backend.play() が呼ばれない
  ↓
  結果: ロードされるが再生されない
```

### 問題のコード（修正前）

```typescript
// src/app/components/player/audio.tsx
useEffect(() => {
  const audio = audioRef.current
  if (!isSong || !audio || typeof src !== 'string' || src.length === 0) return

  if (!songBackendRef.current) {
    songBackendRef.current = new InternalPlaybackBackend(audio)
  }

  songBackendRef.current
    .load({
      src,
      loop,
      autoplay: false, // ← 常にfalse
    })
    .catch((error) => {
      logger.error('Audio source load failed', error)
    })
}, [audioRef, isSong, loop, src]) // ← isPlaying がない
```

## 修正内容

### 修正後のコード

```typescript
useEffect(() => {
  const audio = audioRef.current
  if (!isSong || !audio || typeof src !== 'string' || src.length === 0) return

  if (!songBackendRef.current) {
    songBackendRef.current = new InternalPlaybackBackend(audio)
  }

  // WP5: 2曲目以降の再生を修正 - src変更時にisPlaying状態に応じてautoplay
  songBackendRef.current
    .load({
      src,
      loop,
      autoplay: isPlaying, // ← 現在の再生状態に応じて設定
    })
    .catch((error) => {
      logger.error('Audio source load failed', error)
    })
}, [audioRef, isSong, loop, src, isPlaying]) // ← isPlaying を追加
```

### 変更点
1. `autoplay: false` → `autoplay: isPlaying`
2. 依存配列に `isPlaying` を追加

## 検証結果

- ✅ `npm run lint` - OK
- ✅ `npm run build -- --emptyOutDir false` - OK
- ✅ `npm run test -- --spec src/app/components/player/player.cy.tsx` - 9 passing

## 影響範囲

### 影響を受ける機能
- 手動での曲切り替え（アルバム/プレイリスト内）
- 自動遷移（1曲目終了→2曲目）
- Next/Prevボタンによる曲切り替え

### 影響を受けない機能
- Radio再生（audio.tsx内で別処理）
- Podcast再生（audio.tsx内で別処理）
- 初回再生（1曲目）

## 根因

WP2/WP3/WP4でのPlaybackBackend導入時に混入したバグ。
`backend.load()` の `autoplay` パラメータの扱いを見落としていた。

## 類似バグの防止策

1. **Audio関連の変更時は複数曲での再生テストを実施**
   - 1曲目→2曲目の手動切り替え
   - 自動遷移
   - Next/Prevボタン

2. **autoplayパラメータの扱いに注意**
   - src変更時とisPlaying変更時の両方で適切に処理されているか確認

3. **依存配列の見直し**
   - useEffectの依存配列に状態変数が適切に含まれているか確認

## コミット情報

```
commit fd4bd6d
Author: (kimi k2.5)
Date: 2025-03-18

fix(player): 2曲目以降の再生が開始されないバグを修正 (kimi k2.5)

- src変更時のbackend.load()でautoplayにisPlaying状態を設定
- 依存配列にisPlayingを追加
```

## 関連ファイル

- `src/app/components/player/audio.tsx` - 修正対象
- `src/store/playback-command-controller.ts` - 関連（next/prev制御）
- `src/store/player.store.ts` - 関連（playSong/setSongList）

## テストケース追加の提案

将来の回帰防止のため、以下のテストケース追加を検討：

```typescript
// player.cy.tsx に追加
it('should play next song automatically when current song ends', () => {
  // 2曲目への自動遷移テスト
})

it('should play selected song from album list', () => {
  // アルバム一覧から2曲目を選択して再生
})
```

---

*このバグ修正はWP5実装中に発見され、WP6開始前に修正されました。*
