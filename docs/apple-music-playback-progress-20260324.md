# Apple Music Playback Progress (2026-03-24 JST)

## 目的
Apple Music 楽曲を Minato から `wrapper` と連携して再生する経路の実装進捗を記録する。  
この時点で、再生パスは実用段階に入り、次フェーズをフロントエンド充実へ移せる状態。

## 現在の到達点（結論）
- Apple Music 選曲 → `adamId` 解決 → HLS 取得 → 復号 → ネイティブ再生 まで到達。
- `ALAC` 優先でストリーム選択し、`NativeAudioSidecar` で再生可能。
- `ALAC` 変換時に `ffmpeg` で壊れるケースを避けるため、ALAC variant は FLAC 変換をスキップして `.m4a(ALAC)` をそのまま再生する運用に変更。
- 実ログ上で `load` / `play` が成功し、`playing=true hasSource=true` まで確認済み。

## 実装済みの主要改善

### 1) wrapper 連携の安定化
- prefetch key (`skd://itunes.apple.com/P000000000/s1/e1`) では wrapper 側互換のため `adamId="0"` を送る分岐を追加。
- decrypt socket の早期クローズ (`ECONNRESET` / early close) に対して、短いバックオフ付き 1 回リトライを追加。
- 変更ファイル:
  - `electron/main/core/apple-music-pipeline.ts`
  - `electron/main/core/wrapper-client.ts`
  - `tools/wrapper-main/main.c`（例外後の回復系）

### 2) 復号方式の見直し（fMP4破壊対策）
- セグメント丸ごと復号から、`moof/trun/mdat` を解析した「サンプル単位復号」に変更。
- `trun` の sample size/data_offset を使って encrypted byte range を算出し、該当範囲のみ上書き復号。
- 16byte アライン（CBC block）を考慮して、非ブロック末尾は保持。
- 変更ファイル:
  - `electron/main/core/apple-music-pipeline.ts`

### 3) `stsd` / codec 情報の修復
- 複数 sample entry で Symphonia が失敗するケースに対応し、`stsd` 正規化を実装。
- 無効な小サイズ `alac` entry（例: 36B）を避け、`esds/alac/sinf/frma` を見て適切な entry を選択。
- 必要時は `enca` entry を `frma` に従って clear codec (`mp4a/alac`) へ変換し、`sinf` を除去。
- 変更ファイル:
  - `electron/main/core/apple-music-pipeline.ts`

### 4) ALAC優先 + 変換方針の最適化
- HLS variant は `alac` を優先、なければ `mp4a` fallback。
- 選択 variant の codec/bandwidth 情報を pipeline まで伝搬。
- `ALAC` variant の場合は FLAC 変換をスキップし、lossless ストリームを `.m4a` のまま再生。
- 変更ファイル:
  - `electron/main/core/hls-manager.ts`
  - `electron/main/core/apple-music-pipeline.ts`

### 5) エラー可視化の改善
- sidecar command 失敗コード/メッセージの透過。
- `play` 失敗を握り潰さず `playback-pipeline-failed` として上位に返すよう修正。
- 変更ファイル:
  - `electron/main/core/native-audio-sidecar.ts`
  - `src/playback/backends/apple-music-backend.ts`
  - `native/engine/src/runtime/audio_runtime.rs`
  - `native/engine/src/commands/mod.rs`

## 現在のログで確認できる正常系シグナル
- `[HlsManager] Selected variant ... (alac-preferred)`
- `[AppleMusicPipeline] Skipping FLAC conversion for ALAC variant ...`
- `[NativeAudioSidecar][cmd] ... command=load ...`
- `[NativeAudioSidecar][cmd] ... command=play ... playing=true hasSource=true`

## 既知課題（現時点）
- `decode-audit` 上の `duration=0.000s` 表示が残るケースがある。  
  再生そのものは開始できるが、シーク/終端判定に影響する可能性あり。
- wrapper 側は FairPlay 状態やアカウント状態の影響を受けるため、長時間運用では再接続戦略の検証を継続推奨。

## フロントエンドフェーズへ移行するための引き継ぎ
- バックエンド再生経路は「動作する最短経路」に到達。  
  以後の優先は UI/UX（Apple Music 画面、再生状態表示、エラー表示改善）に移してよい。
- フロント作業中は、以下ログが維持されることを回帰チェックにする:
  1. `alac-preferred` での variant 選択
  2. `Skipping FLAC conversion for ALAC variant ...`
  3. `play ... playing=true hasSource=true`

## 次にバックエンドへ戻る場合の優先順
1. `duration=0.000s` の解消（fragment duration 補完）
2. wrapper 再接続/エラー復帰の標準化
3. ALAC/AAC 混在プレイリストでの連続再生回帰テスト

