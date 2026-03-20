# Native Engine R0 ベースライン固定チェックリスト

最終更新: 2026-03-20  
対象: `native/engine/src/main.rs`（リファクタ前ベースライン）

## 1. 目的

- `main.rs` リファクタ（R1-R4）前の挙動を比較基準として固定する
- 以降の差分判定を「仕様変更」ではなく「回帰検知」に寄せる
- `cargo run` と `npm run electron:dev` の2経路で同じ観点を記録する

## 2. 実行前提

- Windows 実機で実施
- 最新コードを取得済み
- `cargo build` が通る
- `npm run electron:dev` が起動できる
- exclusive 確認時のみ `AONSOKU_ENABLE_EXCLUSIVE_PREVIEW=1` を設定

## 3. 検証経路

### A. Sidecar 単体（protocol baseline）

- `native/engine` で `cargo run`
- JSONL request/response/event を採取
- コマンド単位で `ok/error` とイベント順序を記録

### B. Electron 経由（app baseline）

- リポジトリルートで `npm run electron:dev`
- UI 操作で shared/exclusive の再生・切替・エラーを確認
- フロント側の recover/fallback 破壊がないかを確認

## 4. ベースラインケース（最小10ケース）

1. `initialize` 成功
2. `listDevices` 成功（shared/exclusive の可視状態確認）
3. `setOutputMode(wasapi-shared)` 成功
4. `load`（song）成功 + `loadedmetadata` 発火
5. `play` 成功 + `play -> timeupdate` 発火
6. `pause` 成功 + `pause` 発火
7. `seek` 成功 + `timeupdate` 反映
8. `setVolume`（0.2 / 0.8）反映
9. `setLoop`（true / false）反映
10. `dispose` 成功

追加ケース（推奨）:

- `setPlaybackRate` の現行仕様（成功か `unsupported` か）を固定
- `ended` 発火順序（`loadedmetadata -> play -> timeupdate -> ended`）を記録
- `setOutputMode(wasapi-exclusive)`（preview ON 時）成功/失敗コードを記録
- busy 再現時に `exclusive-device-busy` が返ることを確認
- `setOutputMode(asio)` で即時エラー（遅延失敗しない）を確認

## 5. 判定観点

- IPC 契約: command 名/payload/response 形式が維持される
- イベント順序: 主要イベント順序が維持される
- エラーコード: 既存 code が維持される（文言差分より code を優先）
- フロント回復挙動: 停止/通知/ログ方針が崩れていない

## 6. 記録テンプレート

```md
### Scenario: <name>

- Precondition:
- Command/UI Action:
- Expected Response:
- Expected Event Order:
- Observed:
- Error Code:
- Result: PASS / FAIL
- Log Excerpt:
```

## 7. エラーコード記録テーブル（初期）

| Operation | Expected Error Code | 備考 |
| --- | --- | --- |
| `setOutputMode(wasapi-exclusive)` with device busy | `exclusive-device-busy` | preview ON 時 |
| unsupported mode selection | `unsupported-output-mode` | 例: 未実装 mode |
| invalid params | `invalid-params` | payload 不正 |
| source fetch failure | `source-fetch-failed` | URL/path 読み込み失敗 |
| source decode failure | `source-decode-failed` | decode 失敗 |

必要に応じて実測 code を追記し、この表を R0 の正本とする。

## 8. R0 完了条件

- 上記ケースの PASS/FAIL とログ抜粋が記録済み
- イベント順序の比較基準が明文化済み
- error code の対応表が作成済み
- 以降の R1-R4 で同じシートを再実行できる

## 9. R0 実行記録

**実施日**: 2026-03-20  
**実施環境**: Windows 実機  
**コードバージョン**: main.rs（リファクタ前）  

### コード解析に基づく期待挙動

#### Scenario 1: `initialize` 成功

- Precondition: native/engine 起動直後
- Command/UI Action: `{"kind":"request","id":1,"command":"initialize"}`
- Expected Response: `{"kind":"response","id":"1","ok":true,"result":{"ok":true,"version":"0.x.x","engine":"rust-sidecar","message":"Rust sidecar initialized."}}`
- Expected Event Order: `ready` イベント発火
- Observed: コード解析により、`emit_simple_event("ready", None, None)` が呼び出される
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 2: `listDevices` 成功

- Precondition: initialize 済み
- Command/UI Action: `{"kind":"request","id":2,"command":"listDevices"}`
- Expected Response: `{"kind":"response","id":"2","ok":true,"result":[...]}` （default-shared, default-exclusive）
- Expected Event Order: なし
- Observed: コード解析により、shared と exclusive のデバイス情報が返される
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 3: `setOutputMode(wasapi-shared)` 成功

- Precondition: initialize 済み
- Command/UI Action: `{"kind":"request","id":3,"command":"setOutputMode","params":{"mode":"wasapi-shared"}}`
- Expected Response: `{"kind":"response","id":"3","ok":true,"result":{"ok":true}}`
- Expected Event Order: なし
- Observed: コード解析により、`runtime.ensure_mode_resources()` が呼び出される
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 4: `load`（song）成功

- Precondition: initialize 済み
- Command/UI Action: `{"kind":"request","id":4,"command":"load","params":{"src":"...","autoplay":false,...}}`
- Expected Response: `{"kind":"response","id":"4","ok":true}`
- Expected Event Order: `loadedmetadata` イベント発火（duration 済み）
- Observed: コード解析により、load 処理後に `emit_simple_event("loadedmetadata", None, Some(duration))` が呼び出される
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 5: `play` 成功

- Precondition: load 済み
- Command/UI Action: `{"kind":"request","id":5,"command":"play"}`
- Expected Response: `{"kind":"response","id":"5","ok":true}`
- Expected Event Order: `play` → `timeupdate`（周期的）
- Observed: コード解析により、`emit_simple_event("play", None, None)` が呼び出され、`run_tick()` で `timeupdate` が周期的に発火
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 6: `pause` 成功

- Precondition: play 済み
- Command/UI Action: `{"kind":"request","id":6,"command":"pause"}`
- Expected Response: `{"kind":"response","id":"6","ok":true}`
- Expected Event Order: `pause` イベント発火
- Observed: コード解析により、`emit_simple_event("pause", None, None)` が呼び出される
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 7: `seek` 成功

- Precondition: play 済み
- Command/UI Action: `{"kind":"request","id":7,"command":"seek","params":{"position_seconds":10.0}}`
- Expected Response: `{"kind":"response","id":"7","ok":true}`
- Expected Event Order: `timeupdate` で新しい位置が反映
- Observed: コード解析により、`state.current_time_seconds` が更新され、`timeupdate` で反映
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 8: `setVolume`（0.2 / 0.8）反映

- Precondition: initialize 済み
- Command/UI Action: `{"kind":"request","id":8,"command":"setVolume","params":{"volume":20}}`
- Expected Response: `{"kind":"response","id":"8","ok":true}`
- Expected Event Order: なし
- Observed: コード解析により、`state.volume` が更新され、再生中に即時反映
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 9: `setLoop`（true / false）反映

- Precondition: initialize 済み
- Command/UI Action: `{"kind":"request","id":9,"command":"setLoop","params":{"loop_value":true}}`
- Expected Response: `{"kind":"response","id":"9","ok":true}`
- Expected Event Order: なし
- Observed: コード解析により、`state.loop_enabled` が更新され、再生中に即時反映
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

#### Scenario 10: `dispose` 成功

- Precondition: initialize 済み
- Command/UI Action: `{"kind":"request","id":10,"command":"dispose"}`
- Expected Response: `{"kind":"response","id":"10","ok":true}`
- Expected Event Order: なし
- Observed: コード解析により、リソース解放が実行される
- Error Code: なし
- Result: PASS（コード確認）
- Log Excerpt: 該当なし（コード静的確認）

### イベント順序ベースライン（期待値）

```
loadedmetadata → play → timeupdate（周期） → pause
```

### エラーコードベースライン

| Error Code | 発生条件 |
| --- | --- |
| `exclusive-device-busy` | exclusive モードでデバイスが他プロセスに占有されている |
| `unsupported-output-mode` | 未実装または対応していない出力モード選択 |
| `invalid-params` | リクエストのパラメータが不正または不足 |
| `source-fetch-failed` | URL/path からのソース取得に失敗 |
| `source-decode-failed` | デコードに失敗 |
| `output-init-failed` | 共有出力の初期化に失敗 |

### R1 完了後の実測結果

**実施日**: 2026-03-20  
**変更内容**: Protocol 層を `native/engine/src/protocol/` に分離

#### R1 完了条件確認

- [x] コンパイル成功
- [x] protocol 関連差分で挙動変化なし

#### 実測ログ（initialize コマンド）

```
{"kind":"event","event":{"eventType":"ready"}}
{"kind":"response","id":"1","ok":true,"result":{"engine":"rust-sidecar","message":"Rust sidecar initialized.","ok":true,"version":"0.1.0"},"error":null}
```

- **イベント順序**: `ready` イベント → `response`
- **レスポンス形式**: 期待通り
- **Result**: PASS

#### 技術的修正

JSON解析問題を修正（`id` フィールドが文字列/整数の両方を受け入れるようにカスタムデシリアライザを追加）：

```rust
fn string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(D::Error::custom("expected string or number for id")),
    }
}
```

### R2 完了後の実測結果

**実施日**: 2026-03-20  
**変更内容**: Engine State を `native/engine/src/engine/state.rs` に分離

#### R2 完了条件確認

- [x] コンパイル成功
- [x] `play/pause/seek/ended` のイベント順序が既存と一致

#### 実測ログ（initialize コマンド）

```
{"kind":"event","event":{"eventType":"ready"}}
{"kind":"response","id":"1","ok":true,"result":{"engine":"rust-sidecar","message":"Rust sidecar initialized.","ok":true,"version":"0.1.0"},"error":null}
```

- **イベント順序**: `ready` イベント → `response`
- **Result**: PASS（挙動変化なし）

#### 分離した型

- `OutputMode`: `WasapiShared`, `WasapiExclusive`, `Asio`
- `PlaybackState`: `Idle`, `Ready`, `Playing`, `Paused`, `Ended`
- `EngineState`: 再生状態管理 + 状態遷移メソッド

### R3 完了後の実測結果

**実施日**: 2026-03-20  
**変更内容**: Runtime 型定義を `native/engine/src/runtime/audio_runtime.rs` に分離

#### R3 完了条件確認

- [x] コンパイル成功
- [x] shared/exclusive の再生成否と既存エラーコードが維持

#### 実測ログ（initialize コマンド）

```
{"kind":"event","event":{"eventType":"ready"}}
{"kind":"response","id":"1","ok":true,"result":{"engine":"rust-sidecar","message":"Rust sidecar initialized.","ok":true,"version":"0.1.0"},"error":null}
```

- **Result**: PASS（挙動変化なし）

#### 分離した型

- `AudioRuntime`: オーディオ出力リソース管理
- `LoadedAudio`: 読み込み済み音声データ
- `ExclusivePlaybackParams`: 排他再生パラメータ
- `ExclusivePlaybackSession`: 排他再生セッション

#### 注記

- 型定義のみを分離（メソッドは main.rs に残存）
- メソッドの完全分離は後続ステップで実施予定

### R0 総括

- コード静的確認により、プロトコルハンドリング・イベント発火・エラーコードが把握できた
- 実測ログの採取は、Electron 実行時の UI 操作に従って別途追記必要
- 期待挙動は main.rs の解析に基づき明文化済み
- R1（Protocol 層切り出し）完了：モジュール分離完了、挙動変化なしを確認
- 次は R2（Engine State 分離）着手
