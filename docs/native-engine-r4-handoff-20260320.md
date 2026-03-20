# Native Engine R4 リファクタリング - 作業引き継ぎドキュメント

**最終更新**: 2026-03-20  
**作業者**: opencode  
**次作業者**: （未割り当て）

## 1. 現在の状況

### 完了済み（R0-R3）
- ✅ R0: ベースライン固定（`docs/native-engine-r0-baseline-checklist-20260320.md`）
- ✅ R1: Protocol層切り出し（`src/protocol/`）
- ✅ R2: Engine State分離（`src/engine/state.rs`）
- ✅ R3: Runtime型定義分離（`src/runtime/audio_runtime.rs`）
- ✅ バグ修正: イベントキー `event_type` → `type` 修正済み

### 進行中（R4 - T1: WASAPI Exclusive分離）
現在、T1（WASAPI exclusiveモジュールの分離）を実施中です。

## 2. 作成済みファイル

### 2.1 error.rs（完了）
**場所**: `native/engine/src/error.rs`

```rust
#[derive(Debug, Clone)]
pub struct RuntimeError {
    pub code: &'static str,
    pub message: String,
}

impl RuntimeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExclusiveProbeError {
    pub code: &'static str,
    pub message: String,
}
```

### 2.2 audio/wasapi_exclusive.rs（要修正）
**場所**: `native/engine/src/audio/wasapi_exclusive.rs`

**状態**: 
- main.rsからの抽出は完了（1,582行）
- **問題**: インデントが崩れている（元の `mod wasapi_probe {` 内のコードがそのまま残っている）
- **問題**: インポートパスが `super::ExclusiveProbeError` のまま

**必要な修正**:
1. ファイル全体のインデントを修正（先頭の4スペース削除）
2. `super::ExclusiveProbeError` → `crate::error::ExclusiveProbeError` に変更
3. `#[cfg(target_os = "windows")]` と `#[cfg(not(target_os = "windows"))]` の両方のモジュールが含まれていることを確認

### 2.3 audio/mod.rs（作成済み）
**場所**: `native/engine/src/audio/mod.rs`

```rust
pub mod wasapi_exclusive;

pub use wasapi_exclusive::wasapi_probe::{
    probe_default_exclusive_open,
    run_default_exclusive_playback,
};
```

**注意**: `wasapi_exclusive.rs` の構造に応じて修正が必要な可能性あり

## 3. 未完了のタスク（次作業者へ）

### 3.1 main.rsの修正（優先度：高）

#### 削除が必要な部分：
- 行18-37: `RuntimeError` と `ExclusiveProbeError` の定義（error.rsに移動済み）
- 行39-1620: `#[cfg(target_os = "windows")] mod wasapi_probe { ... }`
- 行1591-1619: `#[cfg(not(target_os = "windows"))] mod wasapi_probe { ... }`（範囲を要確認）

#### 追加が必要な部分：
```rust
mod error;
use error::{ExclusiveProbeError, RuntimeError};

mod audio;
use audio::{probe_default_exclusive_open, run_default_exclusive_playback};
```

#### 置換が必要な部分：
- `wasapi_probe::` → `audio::` （全ての出現箇所）

### 3.2 ビルド検証

```bash
cd native/engine
cargo build
```

**目標**: 
- コンパイルエラー0
- 警告最小化
- `initialize` コマンドが正常動作

### 3.3 回帰テスト

```bash
echo '{"kind":"request","id":1,"command":"initialize"}' | cargo run
```

**期待される出力**:
```json
{"kind":"event","event":{"type":"ready"}}
{"kind":"response","id":"1","ok":true,...}
```

## 4. 注意事項

### 4.1 sedコマンド使用時の注意
- `sed -i` での直接編集は**推奨しない**
- 必ずバックアップを作成してから編集すること
- `git diff` で変更内容を確認すること

### 4.2 Windows特有の実装
- WASAPI exclusiveモジュールはWindows専用
- Non-Windows環境ではスタブ実装が必要
- `#[cfg()]` 属性の付け忘れに注意

### 4.3 インポートパスの整合性
以下の3箇所で整合性が必要：
1. `main.rs` の `use audio::{...}`
2. `audio/mod.rs` の `pub use ...`
3. `audio/wasapi_exclusive.rs` の公開関数

## 5. 作業完了定義（T1）

- [ ] main.rsからwasapi_probeモジュールが削除されている
- [ ] main.rsにerrorモジュールとaudioモジュールのインポートが追加されている
- [ ] `wasapi_probe::` の参照が全て `audio::` に置換されている
- [ ] audio/wasapi_exclusive.rsのインデントが修正されている
- [ ] audio/wasapi_exclusive.rsのインポートパスが修正されている
- [ ] `cargo build` が成功する
- [ ] `initialize` コマンドが正常に動作する

## 6. 次のステップ（R4 - T2以降）

T1完了後は以下を実施：

### T2: AudioRuntimeメソッド移動（0.5-1人日）
- `main.rs` の `impl AudioRuntime` ブロックを `runtime/audio_runtime.rs` に移動
- 約500行

### T3: コマンドハンドラ分離（1.5-2人日）
- `src/commands/` モジュール新設
- `initialize`, `load`, `play`, `pause`, `seek`, `setVolume`, `setLoop`, `setPlaybackRate`, `setOutputMode`, `listDevices` を分離
- 約650行

### T4: プロトコル層拡張（0.5人日）
- `src/protocol/params.rs` 新設
- リクエストパラメータ構造体の移動

### T5: 共通基盤整備（0.5人日）
- 定数の整理
- 未使用インポートの削除

### T6: Main収束（0.5人日）
- main.rsを約150行に削減
- エントリポイントのみを残す

## 7. 参考リンク

- R0チェックリスト: `docs/native-engine-r0-baseline-checklist-20260320.md`
- R4計画書: `docs/native-engine-main-rs-refactor-plan-20260320.md`
- 元のmain.rs: git HEAD（変更前）

## 8. 問い合わせ先

作業中に不明点があれば、以下を参照：
1. このドキュメントの「注意事項」セクション
2. R0チェックリストの「イベント順序ベースライン」
3. 既存のモジュール構成（`src/protocol/`, `src/engine/`, `src/runtime/`）

---
**最終確認日**: 2026-03-20  
**次回作業予定**: T1完了 → T2着手
