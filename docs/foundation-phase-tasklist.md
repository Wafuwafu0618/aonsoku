# 土台フェーズ タスク一覧

## 目的

このドキュメントは、「土台づくりフェーズ」をそのまま実装に移せるタスク一覧に落とし込んだものです。
このフェーズの目的は、現在の Navidrome ベースのプレイヤーを、将来的に次の機能へ拡張できる構造へ変えることです。

- Spotify 統合
- ローカルライブラリとの共存
- 排他モード再生
- HQPlayer 連携
- デザインの洗練

このフェーズでは、上記機能そのものはまだ実装しません。
既存機能を壊さずに、あとから追加できるアーキテクチャを整えるのが目的です。

## 成功条件

このフェーズ完了時に、次の状態になっていることを目指します。

- アプリは引き続き Navidrome デスクトッププレイヤーとして動作する
- 楽曲やキュー項目が `source` を持てる
- 再生処理が現在の内部実装に直結しなくなる
- UI 状態と再生まわりの副作用が分離される
- Electron 固有の振る舞いが、より明確な adapter 境界の内側に収まる

## スコープ外

このフェーズでは、次の項目は明確に対象外とします。

- Spotify OAuth と Spotify 再生
- ローカルファイルのスキャン
- 排他モード出力の実装
- HQPlayer との通信実装
- 全面的な UI リデザイン

## アーキテクチャ上の目標

### 1. source-aware なドメインモデル

Navidrome、Spotify、ローカル音源を同じ UI の中で扱えるようにするため、
サービスレスポンス型をそのまま UI に流さず、アプリ内部で使う共通エンティティを定義する必要があります。

### 2. 再生バックエンドの抽象化

将来的に再生先を次のように切り替えられるよう、差し替え可能な再生バックエンドを用意する必要があります。

- internal playback
- Spotify Connect 制御
- HQPlayer 出力
- 排他モード出力

### 3. store の責務分割

現在の player store は、次の責務をまとめて抱えています。

- キュー状態
- 現在曲の状態
- 再生制御
- audio element との接続
- scrobble の副作用
- Discord RPC
- Electron との同期
- fullscreen や drawer の UI 状態

新しい再生システムを追加する前に、これらの責務を分離しておく必要があります。

## 作業パッケージ

## WP0. 現状把握と安全網の整備

### 目的

リファクタ前に、現在の挙動を固定し、守るべき再生フローを明確にする。

### タスク

- 維持すべき最小限の再生フローを洗い出す
- `player.store.ts` の責務を棚卸しする
- 再生とキューをカバーしている既存の component test を確認する
- 必要なら重要な再生導線に対する smoke test を追加する

### 想定変更箇所

- `src/store/player.store.ts`
- `src/app/components/player/*.tsx`
- `src/app/components/mini-player/*.tsx`
- `src/app/components/fullscreen/*.tsx`
- `src/**/*.cy.tsx`

### 受け入れ条件

- 現状挙動のベースラインが文章で残っている
- 変更してはいけないユーザーフローが明確になっている
- 少なくとも play / pause / next / previous / queue に最低限のテストがある

### 備考

テストで全部を担保できない場合は、手動確認リストを残すこと。

## WP1. ドメインモデルの導入

### 目的

Subsonic のレスポンス型に依存しない、アプリ内部の共通エンティティを作る。

### タスク

- 共通メディアエンティティ用の domain module を作成する
- `MediaSource` を定義する
- `PlaybackBackendId` を定義する
- source-aware な track model を定義する
- source-aware な queue item model を定義する
- Navidrome/Subsonic のレスポンス型から domain entity への mapper を作る

### 追加候補

- `src/domain/media-source.ts`
- `src/domain/playback-backend.ts`
- `src/domain/entities/track.ts`
- `src/domain/entities/queue-item.ts`
- `src/domain/mappers/navidrome/*`

### 初期型の想定

```ts
export type MediaSource = 'navidrome' | 'spotify' | 'local'

export type PlaybackBackendId =
  | 'internal'
  | 'spotify-connect'
  | 'hqplayer'
  | 'exclusive'
```

### 受け入れ条件

- アプリコードが raw response type を直接 import しなくても domain entity を使える
- queue item が `source` を持つ
- Navidrome の track を新しい domain model に変換できる

### レビューゲート

この段階では、UI の見た目や挙動は変えないこと。

## WP2. 再生バックエンド interface の定義

### 目的

再生エンジンを差し替え可能にするための抽象化レイヤを導入する。

### タスク

- `PlaybackBackend` interface を作る
- `load`, `play`, `pause`, `seek`, `setVolume`, `dispose` などの lifecycle を定義する
- state 更新のための callback または subscription を定義する
- 現行の audio 経路を使う `InternalPlaybackBackend` を作る

### 追加候補

- `src/playback/backend.ts`
- `src/playback/backends/internal-backend.ts`
- `src/playback/session-types.ts`

### 受け入れ条件

- アプリが backend contract 経由で再生を扱える
- 初期 backend として現行の Navidrome 内部再生経路を維持できる
- 今後 backend を追加しても page-level UI を大きく書き換えずに済む

### レビューゲート

この interface は、ローカル再生とリモート制御再生の両方に耐えられる設計にすること。

## WP3. store の責務分割

### 目的

現在の player store を、より小さく責務の明確な単位へ分割する。

### タスク

- UI 専用 state と playback/session state を分離する
- 可能な副作用を store 外へ逃がす
- Zustand state から audio element への直接依存を減らす

### 目標構成

- `player-ui store`
- `playback-session store`
- `playback-controller service`

### UI 専用 state の候補

- fullscreen の開閉
- queue drawer の開閉
- lyrics drawer の開閉
- レイアウト系の UI 状態

### playback/session state の候補

- current queue
- current item
- current index
- shuffle
- loop
- progress
- volume
- playing state

### store 外へ移したい副作用

- scrobble
- Discord RPC
- Electron への player state 同期
- audio element 制御

### 受け入れ条件

- playback の中核 store が小さくなり、責務が追いやすい
- UI state の変更が playback の内部事情を知らなくてよい
- 副作用が service か observer の背後に移る

### レビューゲート

このフェーズで最も壊れやすいリファクタなので、一気にやらず段階的に進めること。

## WP4. Navidrome 再生を新経路へ移行

### 目的

現行アプリを動かしたまま、再生処理を新しい抽象化の上へ載せ替える。

### タスク

- queue 作成を domain queue item ベースへ切り替える
- play / pause / next / previous が新 controller 経由で動くようにする
- shuffle / loop / lyrics / scrobble / queue の挙動を維持する
- 現在曲のメタデータが UI と desktop integration に届き続けるようにする

### 想定変更箇所

- `src/store/player.store.ts`
- `src/app/components/player/*.tsx`
- `src/app/components/mini-player/*.tsx`
- `src/app/components/fullscreen/*.tsx`
- `src/app/hooks/use-audio-context.tsx`

### 受け入れ条件

- Navidrome 再生が end-to-end で動作する
- queue の進行に回帰がない
- 現在曲の UI 更新が維持される
- desktop controls が引き続き機能する

### レビューゲート

ここが新アーキテクチャの有効性を確認する最初の重要マイルストーン。

## WP5. UI とキューを source-aware 化

### 目的

新しい source をまだ追加していない段階でも、UI が source 情報を扱えるようにする。

### タスク

- list row、詳細画面、queue item、player state に `source` を通す
- 軽量な source badge component を追加する
- table と詳細画面が mixed-source data に耐えられるようにする

### 想定変更箇所

- `src/app/tables/*.tsx`
- `src/app/components/table/*.tsx`
- `src/app/components/player/*.tsx`
- `src/app/components/queue/*.tsx`
- `src/app/pages/**/*.tsx`

### 受け入れ条件

- アプリが track の source metadata を表示できる
- source の扱いが Navidrome 専用前提になっていない
- 将来 Spotify や local track を足しても queue model を作り直さずに済む

### レビューゲート

この段階では UI を派手に変える必要はない。
重要なのはデータ契約を整えること。

## WP6. Electron / Desktop 依存の adapter 化

### 目的

renderer 内に散らばっている Electron 固有呼び出しをまとめ、境界を明確にする。

### タスク

- desktop/platform adapter 層を作る
- `window.api` の直接利用を adapter 関数経由へ寄せる
- player state 同期も adapter 経由にする
- desktop 専用機能を capability check と一緒に扱う

### 追加候補

- `src/platform/desktop-adapter.ts`
- `src/platform/capabilities.ts`

### 想定変更箇所

- `src/utils/desktop.ts`
- `electron/preload/index.ts`
- `electron/preload/types.ts`
- 現在 `window.api` を直接呼んでいる store / observer 群

### 受け入れ条件

- renderer code が preload contract に各所で直接依存しなくなる
- 将来のネイティブ連携の差し込み口が 1 か所に集約される

### レビューゲート

これは後続の Spotify Connect、HQPlayer、排他モード対応のための重要な下地になる。

## 実装順

推奨する実装順は次の通り。

1. WP0 現状把握と安全網の整備
2. WP1 ドメインモデルの導入
3. WP2 再生バックエンド interface の定義
4. WP3 store の責務分割
5. WP4 Navidrome 再生を新経路へ移行
6. WP5 UI とキューを source-aware 化
7. WP6 Electron / Desktop 依存の adapter 化

## PR の分割案

### PR1. ベースライン確認 + domain model 導入

- WP0
- WP1

### PR2. playback backend interface 導入

- WP2

### PR3. store 分割その1

- UI 専用 state と playback/session state の一次分離

### PR4. store 分割その2 + Navidrome 移行

- 残りの playback migration
- controller / service 抽出

### PR5. source-aware な queue と UI 契約

- WP5

### PR6. desktop adapter 整理

- WP6

## Go / No-Go チェックリスト

実装 Go サインを出す前に、次を確認すること。

- domain model の命名が妥当か
- playback backend abstraction が十分に広いか
- store 分割の方向性が妥当か
- Spotify/local 実装前に source-aware queue を先に入れる方針でよいか
- desktop adapter 整理を foundation phase に含める方針でよいか

## 土台フェーズの完了条件

このフェーズは、次の条件がすべて満たされたときに完了とする。

- Navidrome 再生が引き続き動く
- queue が source-aware になっている
- 再生が backend abstraction 経由で扱われる
- store の責務が新しい再生システムを足せる程度に分離されている
- Electron 固有挙動が、より明確な adapter 境界の内側に収まっている
- 次フェーズであるローカルライブラリ統合に進める状態になっている
