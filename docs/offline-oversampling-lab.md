# Offline Oversampling Lab

聴感比較だけに頼らず、オーバーサンプリング設定の差をオフラインで数値検証するためのCLIです。

## できること

- 同一ソースに対して複数フィルタケースをオフライン処理
- ケースごとのメトリクス出力
  - `peakDbfs`
  - `truePeakDbfs`（4x線形補間による簡易推定）
  - `rmsDbfs`
  - `clipSamples` / `clipRatio`
  - `processingTimeMs`
- 参照ケースとの差分（null残差）を出力
  - `residualPeakDbfs`
  - `residualRmsDbfs`
  - `residualRmsRelativeDb`
  - `correlation`
  - `levelDeltaDb`
  - `gainMatchedScale` / `gainMatchedScaleDb`
  - `gainMatchedPhaseInverted`
  - `residualRmsDbfsGainMatched`
  - `residualRmsRelativeDbGainMatched`
  - `gainMatchedSnrDb`
  - `lagFrames`（簡易アラインメント）
- 同一フィルタ再実行の null depth 検証（`--self-null`）
  - `selfNulls[].residualRmsRelativeDbGainMatched`
  - `selfNulls[].gainMatchedSnrDb`
  - `selfNulls[].bitExact`
- インパルス応答によるフィルタ特性検証（`--analyze-impulse`）
  - `impulseAnalyses[].stopbandAttenuationDb`
  - `impulseAnalyses[].passbandPeakDb`
  - `impulseAnalyses[].impulseWavPath`（`--write-impulse-wav`時）
- 任意で各ケースのWAVを書き出し

## 実行方法

`native/engine` 配下で実行します。

```bash
cargo run --release --bin offline-oversampling-lab -- \
  --src ./sample.flac \
  --filters none,poly-sinc-short-mp,poly-sinc-mp,poly-sinc-lp,poly-sinc-long-lp \
  --target-sample-rate 192000 \
  --output-dir ./offline-lab \
  --write-wav
```

標準出力に `report.json` 相当のJSONを表示し、`--output-dir` を指定すると同内容を `report.json` に保存します。

## オプション

- `--src <path-or-url>`: 入力音源（必須）
- `--filters <csv>`: 比較ケース（未指定時は主要プリセット一式）
- `--target-sample-rate <hz>`: 出力レート（未指定時はソースレート）
- `--output-dir <path>`: レポート/WAV出力先
- `--write-wav`: 各ケースのWAVを出力（`--output-dir` 必須）
- `--volume <linear>`: 最終出力ゲイン（線形、既定 `1.0`）
- `--reference-filter <token>`: 差分比較の基準ケース（既定 先頭ケース）
- `--max-lag-frames <n>`: 差分比較アライン探索幅（既定 `2048`）
- `--lag-window-frames <n>`: 差分比較に使う探索窓（既定 `48000`）
- `--parametric-eq-json <path>`: 任意のEQ設定JSON（`ParametricEqConfig` 形式）
- `--self-null`: 同一フィルタを再実行して null depth を算出
- `--analyze-impulse`: フィルタごとのインパルス応答を解析
- `--impulse-frames <n>`: インパルス入力長（既定 `65536`）
- `--write-impulse-wav`: インパルス応答WAVを出力（`--analyze-impulse` と `--output-dir` 必須）
- `--stopband-start-hz <hz>`: ストップバンド評価開始周波数（未指定時は自動）

## 補足

- このCLIは現在のネイティブ実装に合わせた検証ツールです。
- 一部フィルタIDはネイティブHQプロファイルに未マップで、`poly-sinc-mp` 相当にフォールバックします。該当時は `notes` に明記されます。
- `truePeakDbfs` は簡易推定です。厳密測定が必要な場合は外部メータ併用を推奨します。
- 長尺音源ではメモリ使用量が増えるため、まずは短い素材・少ないフィルタ数で試すのを推奨します。

## 客観比較レシピ

```bash
cargo run --release --bin offline-oversampling-lab -- \
  --src ./sample.flac \
  --filters poly-sinc-short-mp,poly-sinc-mp,poly-sinc-lp \
  --reference-filter poly-sinc-short-mp \
  --target-sample-rate 96000 \
  --output-dir ./offline-lab \
  --self-null \
  --analyze-impulse \
  --write-impulse-wav
```

- フィルタ間の差分: `comparisons[].residualRmsRelativeDbGainMatched`（小さいほど近い）
- 同一フィルタの再現性: `selfNulls[].bitExact` / `selfNulls[].gainMatchedSnrDb`
- ストップバンド減衰: `impulseAnalyses[].stopbandAttenuationDb`（より負側が強い）
