# WP5 オーバーサンプリング実装計画（HQPlayer 5 Manual 反映版）

最終更新: 2026-03-19

## 1. 目的

- Aonsoku 内で高品質オーバーサンプリングを完結させる
- 高タップ FIR 前提で、実行不能時は停止して理由を通知する
- HQPlayer で一般的な命名規則（`poly-sinc-*`）に揃え、学習コストを下げる

## 2. HQPlayerマニュアルからの設計前提

- HQPlayer 5 では `poly-sinc` 系が推奨フィルタ群として扱われる
- `poly-sinc` 内でも `lp/mp/ip/shrt/long/ext/gauss` などの位相・長さバリエーションがある
- `*-2s` は高出力レート時のCPU負荷軽減を目的とした二段オーバーサンプリング
- `closed-form` / `sinc-*` は高負荷かつ高精度の拡張群で、後段フェーズ向き
- Dither/NS、SDM modulator は重要だが、WP5初期はPCM oversamplingを優先する

## 3. 方向性（合意事項）

- 初期実装は `poly-sinc` 系を優先する
- プリセット名/内部IDは HQPlayer 命名規則に合わせる
- 将来的なプリセット追加を前提に、実装と定義を分離する
- 高性能経路はネイティブDSPを前提とし、WebAudio依存にしない
- 出力経路自体は `WASAPI共有` / `WASAPI排他` / `ASIO` を維持する
- ただしオーバーサンプリング品質経路は `WASAPI排他` / `ASIO` のみを対象とする

## 4. スコープ

### In Scope

- PCM オーバーサンプリング（`poly-sinc` 系）
- CPU 実装（先行）
- GPU 実装（後続、同一APIで差し替え）
- プリセット選択UIと失敗時のログ/通知

### Out of Scope（初期）

- DSDモジュレータ実装
- HQPlayer 本体との連携
- 主観評価のみでの最適化（測定ベースを優先）

## 5. 音声パイプライン

`decode -> oversample DSP -> output backend`

- `decode`: 既存ローカル/ストリーミングのデコード結果を統一PCMへ
- `oversample DSP`: poly-sincフィルタ処理
- `output backend`: WASAPI共有/排他、ASIO
- `oversampling quality path`: WASAPI排他/ASIO（共有はOSミキサー経由のため対象外）

## 6. 拡張可能な設計

実装を「フィルタ」「プリセット」「実行環境」に分離する。

### 6.1 FilterSpec（実装単位）

- フィルタ実装の能力を表現する定義
- 例: `id`, `phase`, `tapCount`, `supportedRatios`, `latencySamples`
- `phase` は `minimum` だけでなく `linear` / `intermediate` を段階導入する

### 6.2 PresetSpec（ユーザー選択単位）

- ユーザーが選ぶ設定プロファイル
- 例: `displayName`, `filterId`, `targetRatePolicy`, `preferredEngine`, `onFailurePolicy`

### 6.3 Capability（実行環境）

- デバイス/API/計算資源の可用性
- 例: `outputApi`, `supportsGpu`, `maxTapCount`, `latencyBudgetMs`

### 6.4 Resolver（選択ロジック）

- 入力: `PresetSpec + Capability`
- 出力: 実行可能な `FilterSpec + Engine + OutputConfig`
- 実行不能時は処理を停止し、理由をUI通知して詳細ログを出力

## 7. プリセット導入ロードマップ

### v1（実装済み）

1. `poly-sinc-short-mp`（低負荷/低遅延）
2. `poly-sinc-mp`（標準運用）
3. `poly-sinc-ext2`（高タップ高音質）

### v1.1（次フェーズ）

1. `poly-sinc-lp`（線形位相の基準）
2. `poly-sinc-long-ip`（intermediate位相）
3. `poly-sinc-gauss`（時間周波数バランス）

### v1.2（高レート最適化）

1. `poly-sinc-ext2-2s` 相当の二段処理モード
2. `poly-sinc-gauss-2s` 相当の二段処理モード

注記: `-2s` はフィルタIDを増やすより、`stagingMode: single|two-stage` の実装軸で持つ方が管理しやすい。

### v2（評価後）

- `closed-form*` / `sinc-*` の段階導入を検討
- CPU/GPUコストと起動・曲切替レイテンシを計測して採否判断

## 8. 実装マイルストン

### M1. 設計基盤

- `FilterSpec/PresetSpec/Capability` の型定義
- Registry + Resolver の骨格実装
- 設定保存スキーマ（将来プリセット追加に備える）

### M2. CPU版 poly-sinc

- 固定倍率アップサンプリング（44.1k系/48k系の整数倍優先）
- 安定動作と品質基準の確立

### M3. 出力統合

- WASAPI共有/排他/ASIO で同一DSPチェーンを動作
- 再生中切替と失敗時の停止/通知/ログ出力

### M4. GPU版

- CPU実装と同一I/O契約でGPUエンジン追加
- 品質差分/遅延/負荷を比較評価

### M5. 安定化

- 排他初期化や切替時の失敗耐性
- 曲切替時の遅延/残音/タイムアウトの抑制

### M6. フィルタ拡張（v1.1）

- `poly-sinc-lp` / `poly-sinc-long-ip` / `poly-sinc-gauss` を追加
- `phase` 型拡張とUI表示整備

### M7. 二段処理（v1.2）

- `-2s` 相当の二段オーバーサンプリング導入
- 高サンプルレートでのCPU負荷削減効果を測定

## 9. UI/設定ポリシー

- フィルタ名は原則 HQPlayer 準拠で表示（例: `poly-sinc-ext2`）
- 各プリセットに以下を表示する
  - 位相特性
  - 推定tap規模
  - 推奨環境（CPU/GPU・出力API）
  - 推定遅延
- 実行時に選択不可な場合、理由と推奨手動切替先を明示する

## 10. リスクと対策

- 高タップ時の過負荷
  - 対策: 事前Capability判定 + 実行前警告 + 失敗時停止
- API差異による不整合
  - 対策: Output backend前の共通PCM契約を固定
- GPU依存による環境差
  - 対策: CPU経路を常に正経路として維持
- 二段処理導入時の音質回帰
  - 対策: 測定（周波数応答/エイリアシング）とAB確認をセットで実施

## 11. 参照資料

- HQPlayer 5 Desktop Manual（ローカル変換版）  
  `docs/hqplayer5desktop-manual.md`
- Signalyst HQPlayer Desktop  
  https://signalyst.com/hqplayer-desktop/
