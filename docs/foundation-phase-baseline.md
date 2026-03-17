# 土台フェーズ ベースライン

## 目的

このドキュメントは、土台フェーズ着手前の再生挙動と確認対象を固定するためのベースラインです。
以後のリファクタでは、この内容を崩さないことを前提に進めます。

## 現在の再生導線

### 1. 楽曲再生

- 楽曲一覧やアルバム一覧から `usePlayerStore.getState().actions.setSongList(...)` でキューを構築する
- 再生実体は `src/app/components/player/player.tsx` の `<audio>` 要素
- ストリーム URL は `getSongStreamUrl(song.id)` で Subsonic `/rest/stream` を参照する
- 現在曲は `player.store.ts` の `songlist.currentSong` と `currentSongIndex` で管理される

### 2. キュー進行

- `playNextSong` / `playPrevSong` がキュー遷移を担う
- shuffle 時は `originalList` と `currentList` の両方を保持する
- loop は `LoopState.Off / All / One` の 3 状態
- 最終曲到達時は `LoopState.All` なら先頭へ戻り、それ以外は再生終了時に state をクリアする

### 3. podcast / radio

- mediaType は `song | radio | podcast`
- radio は専用の `radioList`
- podcast は専用の `podcastList` と `podcastListProgresses`
- 現時点の foundation phase では、主対象は `song` の再生基盤

### 4. デスクトップ連携

- renderer から `window.api.updatePlayerState(...)` で Electron 側へ再生状態を送る
- Electron 側は tray / taskbar / native controls を更新する
- デスクトップ側の再生操作は `window.api.playerStateListener(...)` で renderer に戻る

### 5. 副作用

現在の `player.store.ts` は次の副作用を内部で扱っている。

- scrobble 送信
- Discord RPC 更新
- Electron 側への再生状態同期
- IndexedDB への songlist 永続化
- fullscreen 状態の補正

## 守るべきユーザーフロー

foundation phase で維持すべき最小フローは次の通り。

1. 楽曲一覧から曲を再生できる
2. play / pause が切り替わる
3. next / previous でキュー移動できる
4. shuffle が機能する
5. loop が機能する
6. progress が表示・更新される
7. volume が変更できる
8. current song のタイトル・アーティスト・画像が更新される
9. desktop controls が壊れない
10. podcast / radio の既存再生導線を壊さない

## 現在ある自動テスト

確認した component test:

- `src/app/components/player/player.cy.tsx`
- `src/app/components/player/track-info.cy.tsx`
- `src/app/components/player/radio-info.cy.tsx`

現在カバーされている内容:

- player のマウント
- play / pause ボタン動作
- shuffle ボタン動作
- loop ボタン動作
- volume 変更
- progress 表示
- like 動作
- track info 表示
- radio info 表示

## この PR で追加する安全網

- next / previous によるキュー遷移確認を component test に追加する

## 手動確認リスト

自動テストだけでは不足するため、以後の refactor では次を手動確認する。

- 楽曲一覧から再生開始できる
- アルバム詳細から連続再生できる
- queue に曲を追加して順番どおり進行する
- shuffle オン・オフで現在曲の扱いが破綻しない
- loop all / one / off が意図どおり動く
- podcast の resume が維持される
- radio 再生が開始できる
- tray / taskbar の再生ボタンが効く
- fullscreen player / mini player が壊れていない

## player.store の責務棚卸し

現在の `src/store/player.store.ts` には、少なくとも以下の責務が混在している。

- 再生キュー管理
- 現在曲管理
- shuffle / loop 制御
- progress / duration / volume 管理
- drawer / lyrics / fullscreen UI 状態
- replay gain 設定
- scrobble の発火タイミング管理
- Discord RPC 更新
- Electron 再生状態同期
- Podcast progress 永続化の補助
- songlist の IndexedDB 永続化

このため、foundation phase ではまず責務分割可能な構造へ寄せる必要がある。
