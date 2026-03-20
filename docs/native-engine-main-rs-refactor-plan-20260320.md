# Native Engine `main.rs` リファクタ計画

最終更新: 2026-03-20
対象: `native/engine/src/main.rs`

## 1. 目的

- `main.rs` に集中している責務を分離し、保守性と変更安全性を上げる
- 後続の `symphonia + cpal` 移行での差分範囲を限定する
- まずは挙動非変更（no behavior change）で進める

## 2. 背景と課題

現状の `main.rs` は以下の責務を同時に持っている。

- JSONL protocol（request/response/event）
- コマンドディスパッチ
- 再生状態管理（`EngineState`）
- shared 出力（`rodio::OutputStream` / `Sink`）
- exclusive 出力（WASAPI exclusive worker + HQ resample）
- source 取得（http/file/path）と decode

これにより、1箇所の変更で複数経路に副作用が出るリスクが高い。

## 3. リファクタ方針

- 既存 IPC 契約は維持（`initialize/load/play/pause/seek/...`）
- 既存エラーコードを維持（UI と回復処理を壊さない）
- まずはモジュール分割のみ。アルゴリズム変更はしない
- 小さく分けて段階的にマージし、各段階でビルドと手動確認を行う

## 4. スコープ

### In Scope

- `main.rs` の責務分離
- Rust モジュール構成の再整理
- protocol/engine/runtime の境界定義
- 既存挙動維持の回帰確認

### Out of Scope

- `rodio` からの置換
- デコード/出力方式の仕様変更
- 新機能追加（ASIO 本実装など）

## 5. 目標構成（提案）

```text
native/engine/src/
  main.rs
  error.rs
  protocol/
    mod.rs
    types.rs
    io.rs
  engine/
    mod.rs
    state.rs
    commands.rs
    tick.rs
  runtime/
    mod.rs
    audio_runtime.rs
    shared_output.rs
    exclusive_output.rs
    source_loader.rs
```

補足:

- `main.rs` は「入出力ループ」と「command -> handler 呼び出し」だけに縮小
- `engine/commands.rs` は純ロジック寄り（状態遷移）
- `runtime/*` は I/O 寄り（デバイス、デコード、再生実体）

## 6. 実施ステップ

### R0. ベースライン固定（0.5日）

- 主要経路の手動チェック項目を先に固定
- ログ採取手順を決める（load/play/seek/pause/end/error）

完了条件:

- 以降の比較基準が明文化されている

### R1. Protocol 層切り出し（1日）

- `SidecarRequest/Response/Event` と JSONL 出力関数を `protocol/` へ分離
- `emit_*` / `parse_params` を `protocol` に移動

完了条件:

- コンパイル成功
- protocol 関連差分で挙動変化なし

### R2. Engine State 分離（1日）

- `EngineState`, `PlaybackState`, `OutputMode` を `engine/state.rs` へ
- `run_tick` と状態遷移メソッドを `engine/tick.rs` / `engine/commands.rs` へ

完了条件:

- `play/pause/seek/ended` のイベント順序が既存と一致

### R3. Runtime 分離（1.5日）

- `AudioRuntime` と補助構造体を `runtime/audio_runtime.rs` へ
- source 取得を `runtime/source_loader.rs` へ
- shared/exclusive 実装依存を `runtime/shared_output.rs`, `runtime/exclusive_output.rs` に分離

完了条件:

- shared/exclusive の再生成否と既存エラーコードが維持

### R4. Main 収束と整備（0.5日）

- `main.rs` を薄く保つ（分岐ロジックの薄化）
- モジュール境界コメントと最小ドキュメント追記

完了条件:

- `main.rs` が bootstrap 相当の責務に限定される

## 7. 見積り

- 合計: 4.5〜6人日（1人）
- 追加バッファ（実機検証・手戻り）: +1〜2人日
- 現実レンジ: 5.5〜8人日

## 8. リスクと対策

- リスク: イベント順序の微差分でフロント状態が崩れる
  - 対策: `loadedmetadata -> play -> timeupdate -> ended` の順序を記録比較
- リスク: error code 変更で recover/fallback が壊れる
  - 対策: 既存 code 文字列の snapshot テストを追加
- リスク: 分割中の循環依存
  - 対策: `protocol <- engine <- runtime` の依存方向を固定

## 9. 検証計画

### 自動

- `cargo build`
- 可能なら `cargo test`（unit を段階追加）

### 手動（Windows 実機）

- shared: load/play/pause/seek/loop/volume
- exclusive: mode切替、再生、停止、失敗時エラー
- 曲切替連打時のハング/残音/クラッシュ有無

## 10. ロールバック方針

- 各 R ステップを独立コミットし、段階ごとに戻せる単位で統合
- 破綻時は「直前ステップ」まで戻して再分割

## 11. 次フェーズへの接続

このリファクタ完了後に、デコーダ/出力バックエンド差し替え点を限定できる。

- decoder 差し替え対象: `runtime/source_loader.rs` + decode adapter
- output 差し替え対象: `runtime/shared_output.rs`（必要に応じて exclusive も）

