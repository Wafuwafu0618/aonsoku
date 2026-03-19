# WP5 オーバーサンプリング実装計画（poly-sinc準拠）

最終更新: 2026-03-19

## 1. 目的

- Aonsoku 内で高品質オーバーサンプリングを完結させる
- 高タップ FIR を前提にしつつ、失敗時は明示的に停止して理由を通知する
- HQPlayer で一般的な命名規則（`poly-sinc-*`）に合わせ、学習コストを下げる

## 2. 方向性（合意事項）

- 初期実装は `poly-sinc` 系を優先する
- プリセット名/内部IDは HQPlayer 命名規則に合わせる
- 将来的なプリセット追加を前提に、実装と定義を分離する
- 高性能経路はネイティブDSPを前提とし、WebAudio依存にしない
- 出力は `WASAPI共有` / `WASAPI排他` / `ASIO` をサポート対象とする

## 3. スコープ

### In Scope

- PCM オーバーサンプリング（poly-sinc系）
- CPU 実装（先行）
- GPU 実装（後続、同一APIで差し替え）
- プリセット選択UIと失敗時のログ/通知

### Out of Scope（初期）

- DSDモジュレータの実装
- HQPlayer そのものとの連携
- 主観評価のみでの最適化（測定ベースを優先）

## 4. 音声パイプライン

`decode -> oversample DSP -> output backend`

- `decode`: 既存ローカル/ストリーミングのデコード結果を統一PCMへ
- `oversample DSP`: poly-sincフィルタ処理
- `output backend`: WASAPI共有/排他、ASIO

## 5. 拡張可能な設計

実装を「フィルタ」「プリセット」「実行環境」に分離する。

### 5.1 FilterSpec（実装単位）

- フィルタ実装の能力を表現する定義
- 例: `id`, `phase`, `tapCount`, `supportedRatios`, `latencySamples`

### 5.2 PresetSpec（ユーザー選択単位）

- ユーザーが選ぶ設定プロファイル
- 例: `displayName`, `filterId`, `targetRatePolicy`, `preferredEngine`, `onFailurePolicy`

### 5.3 Capability（実行環境）

- デバイス/API/計算資源の可用性
- 例: `outputApi`, `supportsGpu`, `maxTapCount`, `latencyBudgetMs`

### 5.4 Resolver（選択ロジック）

- 入力: `PresetSpec + Capability`
- 出力: 実行可能な `FilterSpec + Engine + OutputConfig`
- 実行不能時は処理を停止し、理由をUI通知して詳細ログを出力

## 6. 初期プリセット（v1）

1. `poly-sinc-short-mp`
- 用途: 低負荷/低遅延
- 想定: WASAPI共有や低スペック環境

2. `poly-sinc-mp`
- 用途: 標準運用
- 想定: 常用バランス

3. `poly-sinc-ext2`
- 用途: 高タップ高音質
- 想定: WASAPI排他/ASIO + 高性能CPU/GPU

失敗時挙動:
`poly-sinc-ext2` が実行不能な場合は自動降格せず、理由を表示してユーザー選択に戻す

## 7. 実装マイルストン

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

### M5. 検証と公開

- 測定: エイリアシング残留、周波数応答、レイテンシ
- 運用: ログ可観測性、異常時の通知、UI説明の明確化

## 8. UI/設定ポリシー

- フィルタ名は原則 HQPlayer 準拠で表示（例: `poly-sinc-ext2`）
- 各プリセットに以下を表示:
  - 位相特性
  - 推定tap規模
  - 推奨環境（CPU/GPU・出力API）
  - 推定遅延
- 実行時に選択不可な場合、理由と推奨手動切替先を明示

## 9. リスクと対策

- 高タップ時の過負荷
  - 対策: 事前Capability判定 + 実行前警告 + 失敗時停止
- API差異による不整合
  - 対策: Output backend前の共通PCM契約を固定
- GPU依存による環境差
  - 対策: CPU経路を常に正経路として維持

## 10. 参照資料

- Rainlain HQPlayerフィルター解説  
  https://www.rainlain.com/index.php/ja/2025/06/09/3677/
- iCAT HQP Filter解説  
  https://www.icat-inc.com/hqp-filter.html
- Signalyst HQPlayer Desktop  
  https://signalyst.com/hqplayer-desktop/
