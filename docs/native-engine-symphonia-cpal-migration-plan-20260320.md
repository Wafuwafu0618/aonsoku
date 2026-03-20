# Native Engine `symphonia + cpal` 移行計画

最終更新: 2026-03-21
前提: `main.rs` 責務分割リファクタ実施後
関連: `docs/native-engine-main-rs-refactor-plan-20260320.md`

## 0. 進捗（2026-03-21）

- M0: 実装完了
  - IPC 契約凍結ドキュメント: `docs/native-engine-ipc-contract-freeze-20260320.md`
  - decode/conversion/target sample rate/underrun 計測ログを追加
- M1: 実装完了
  - `decoder` モジュールに `DecodedStream` 相当 I/F を追加
  - shared runtime の decode 経路を `rodio adapter` 経由へ切替
- M2: 実装完了（2026-03-21）
  - `symphonia` decoder backend を追加（`AONSOKU_NATIVE_DECODER=symphonia`）
  - `load` metadata（duration/channels/sample rate）と shared の decode 経路を `symphonia` で切替可能化
  - `inspect` は metadata 優先で軽量化（不要な PCM 全展開を回避）
  - seek 再初期化時は開始位置以前の PCM を破棄しつつ f32 経路を維持
  - 実機確認: `decoder backend selected=symphonia` / `decode-audit` / exclusive render summary を確認
  - 注記: exclusive 実再生ループ内部の decode は現時点では rodio のまま（計画どおり M4 で切替）
- M3: 実装着手（2026-03-21）
  - shared 出力 backend を `AONSOKU_NATIVE_SHARED_OUTPUT=rodio|cpal` で切替可能化（既定: `cpal`）
  - `cpal` stream コールバックで `play/pause/seek/loop/rate/volume` を state 駆動
  - decode 済み PCM を runtime でキャッシュし、shared 再構築時の再デコードを抑制
- M4: 実装着手（2026-03-21）
  - exclusive 再生ワーカーの入力を `audio_data`（rodio decode）から `DecodedPcmData` 由来 `SharedPcmTrack` へ切替
  - WASAPI worker / HQ sinc resampler（rubato）は維持し、decode 起点のみ `decoder_backend.decode_pcm` へ移行
  - runtime に exclusive 用 decode キャッシュを追加し、`load`/`clear` で破棄する運用へ統一

## 1. 目的

- `rodio` 依存を段階的に縮小/撤去し、音声処理を明示的に制御できる構成へ移行する
- 厳密ビットパーフェクトではなく、意図しない処理を減らす
- HQPlayer 的体験（意図した DSP/リサンプル優先）を壊さない

## 2. 非目的

- 1回で全面置換しない（段階導入）
- UI 契約（IPC コマンド/イベント）を壊さない
- 先に ASIO 完全実装を狙わない

## 3. 現状の依存ポイント

- decode: `rodio::Decoder`
- shared output: `rodio::OutputStream` + `Sink`
- exclusive output: WASAPI 直実装だが、入力は `rodio::Decoder` / `Source` 前提

課題:

- decode/再生制御/出力が `rodio` の型に引っ張られている
- `skip_duration/speed/repeat_infinite` の暗黙処理に依存している

## 4. 移行戦略（2段階）

### Stage A: Decoder 先行置換（低リスク）

- decode を `symphonia` に置換
- output は既存（shared/exclusive）を維持
- 目的: `rodio::Source` 依存を解く準備

### Stage B: Output 置換（高影響）

- shared 出力を `cpal` ベースへ移行
- exclusive は 2案を比較して決定
  - 案1: exclusive は現行 WASAPI worker を維持（decode 入力だけ差し替え）
  - 案2: exclusive も `cpal` 経由へ統一

推奨は案1（先に安定性確保、統一は後続）。

## 5. 目標アーキテクチャ

```text
source fetch/read
  -> demux/decode (symphonia)
  -> PCM queue (f32 interleaved)
  -> DSP chain (oversampling / volume / optional rate conversion)
  -> output adapter
     - shared: cpal stream
     - exclusive: WASAPI worker (phase1) / cpal-exclusive (phase2 option)
```

## 6. 実施ステップ

### M0. 契約固定と計測点追加（0.5日）

- IPC 契約の凍結（型・イベント順序）
- 比較指標の追加（ログ）
  - decode format
  - target sample rate
  - conversion path
  - underrun 回数

### M1. Decode 抽象導入（1日）

- `DecodedStream` 相当の内部 I/F を導入
- 既存 runtime は一旦 `rodio adapter` 経由で接続

完了条件:

- ビルド成功、挙動差分なし

### M2. `symphonia` デコーダ実装（1.5〜2日）

- duration/channels/sample rate 取得
- PCM 出力（まず f32）
- seek 再初期化パスを実装

完了条件:

- `load` / `seek` / `duration` が既存同等

### M3. Shared 出力 `cpal` 化（2〜3日）

- 出力スレッド + リングバッファ導入
- `play/pause/volume/loop` の互換動作を実装
- underrun 時のエラー/ログポリシーを決定

完了条件:

- shared 経路で基本再生操作が回帰なし

### M4. Exclusive 経路接続（2〜3日）

- 推奨: 現行 WASAPI worker を維持し、入力を `symphonia` 由来 PCM に切替
- 既存の HQ resampler（rubato）を維持

完了条件:

- exclusive の再生・seek・loop・volume が現状同等

### M5. 後片付け（1日）

- `rodio` 参照を削除
- 使っていない adapter/型を削除
- ドキュメントとチェックリスト更新

## 7. 見積り

- 合計: 8〜14人日（1人）
- うち実機依存バッファ: 2〜3人日

内訳目安:

- Stage A（M0-M2）: 3〜4.5人日
- Stage B（M3-M5）: 5〜9.5人日

## 8. リスクと対策

- リスク: `seek`/`loop` の互換差分
  - 対策: 既存ケースを先にテーブル化して比較テスト化
- リスク: `cpal` コールバック内での過負荷
  - 対策: 重い DSP は別スレッド実行、コールバックはコピーのみ
- リスク: exclusive の安定性後退
  - 対策: phase1 は WASAPI worker 維持、`cpal-exclusive` は別フェーズ

## 9. 互換要件（必須）

- IPC コマンド名・payload・イベント型は維持
- 既存 error code を優先維持（`exclusive-device-busy` 等）
- `NativePlaybackBackend` 側のフォールバック挙動を壊さない

## 10. 検証計画

### 自動

- `cargo build`
- decode unit test（duration/metadata/seek）
- state machine test（play/pause/seek/load）

### 手動（Windows 実機）

- shared: 連続再生、シーク連打、音量変化
- exclusive: 他アプリ同時再生時の排他、デバイス変更時挙動
- oversampling ON/OFF、target sample rate 切替

## 11. ロールバック/セーフティ

- feature flag 導入を推奨:
  - `AONSOKU_NATIVE_DECODER=rodio|symphonia`
  - `AONSOKU_NATIVE_SHARED_OUTPUT=rodio|cpal`
- デフォルトは段階ごとに保守的に切替
- 不具合時は flag で即復旧できる状態を維持

## 12. 完了条件

- `rodio` が runtime から撤去されている
- shared/exclusive の必須操作で回帰がない
- oversampling 経路が意図した変換のみで動作する
- 手動確認チェックリスト更新済み
