# Aonsoku Native Audio — カスタムオーバーサンプリングエンジン実装仕様

## 概要

現在 `wasapi_exclusive.rs` 内で `rubato::SincFixedIn` を直接使用しているリサンプラーを、
自前の高性能オーバーサンプリングエンジンに置き換える。

目標：
- フィルタ係数を完全に自前で管理できるようにする（窓関数・タップ数・カットオフの自由な設定）
- 短フィルタ（〜2048タップ）はポリフェーズ直接畳み込み＋SIMD
- 長フィルタ（2048タップ超）はFFT overlap-add（`rustfft`使用）
- decode／resample／EQをパイプライン化し、producerスレッドの逐次処理を解消する
- rubato依存を段階的に除去する

---

## フェーズ構成

| Phase | 内容 |
|-------|------|
| 1 | 抽象層（trait定義・既存rubatoをwrap） |
| 2 | 係数設計モジュール（sinc×窓関数） |
| 3 | 短フィルタエンジン（ポリフェーズ直接畳み込み＋SIMD） |
| 4 | 長フィルタエンジン（FFT overlap-add） |
| 5 | パイプライン化＋マルチスレッド最適化 |

本仕様書はPhase 1〜2を対象とする。Phase 3以降は別途作成する。

---

## Phase 1: 抽象層

### 配置

```
native/engine/src/oversampling/
  mod.rs          ← pub use、フィルタID解決
  filter.rs       ← OversamplingFilter trait
  rubato_impl.rs  ← 既存rubatoのwrapper（暫定実装）
  registry.rs     ← フィルタIDと実装の対応表
```

### trait定義

Phase 1〜2では `OversamplingFilter::process_chunk` は **producerスレッド専用** とする。
render loop（WASAPI書き込みスレッド）から直接呼ばない。
render loopは producer で生成済みのPCMチャンクを消費する役割に限定する。

```rust
/// チャンク単位でオーバーサンプリングを行うフィルタの抽象インターフェース。
/// 実装はスレッドセーフである必要はない（producerスレッドが排他的に使用する）。
pub trait OversamplingFilter: Send {
    /// フィルタの識別子（ログ・audit用）
    fn filter_id(&self) -> &'static str;

    /// 変換レシオ（output_rate / input_rate）
    fn ratio(&self) -> f64;

    /// チャンネル数
    fn channels(&self) -> usize;

    /// チャンクを処理する。
    /// - input: インターリーブされたf32サンプル（frames × channels）
    /// - output: 出力バッファ（事前確保済み、input.len() * ratio 以上）
    /// - 戻り値: 書き込んだサンプル数
    fn process_chunk(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<usize, String>;

    /// 内部状態（遅延バッファ等）をリセットする。
    /// シーク時・ループ折り返し時に呼ばれる。
    fn reset(&mut self);

    /// フィルタの遅延サンプル数（出力レートベース）。
    /// タイミング補正に使用する。
    fn latency_frames(&self) -> usize;
}
```

### フィルタプロファイルとID対応

フィルタIDは独自命名体系を使用する（HQPlayerの名称は使わない）。
新しいIDを追加する場合は `registry.rs` に登録するだけで使えるようにする。

```rust
// registry.rs
pub fn create_filter(
    filter_id: Option<&str>,
    input_rate: u32,
    output_rate: u32,
    channels: usize,
) -> Box<dyn OversamplingFilter> {
    match filter_id {
        Some("sinc-s-mp")         => { /* 短・最小位相 */ }
        Some("sinc-m-mp")         => { /* 標準・最小位相（デフォルト） */ }
        Some("sinc-m-lp")         => { /* 標準・線形位相 */ }
        Some("sinc-l-lp")         => { /* 長・線形位相 */ }
        Some("sinc-l-mp")         => { /* 長・最小位相 */ }
        Some("sinc-l-ip")         => { /* 長・中間位相 */ }
        Some("sinc-m-lp-ext")     => { /* 拡張周波数応答 */ }
        Some("sinc-m-lp-ext2")    => { /* 拡張+高減衰 */ }
        Some("sinc-xl-lp")        => { /* 極端カットオフ・線形 */ }
        Some("sinc-xl-mp")        => { /* 極端カットオフ・最小位相 */ }
        Some("sinc-m-gauss")      => { /* Gaussian窓・標準 */ }
        Some("sinc-l-gauss")      => { /* Gaussian窓・長 */ }
        Some("sinc-xl-gauss")     => { /* Gaussian窓・超長 */ }
        Some("sinc-xl-gauss-apod")=> { /* Gaussian窓・アポダイジング */ }
        Some("sinc-hires-lp")     => { /* HiRes専用・線形 */ }
        Some("sinc-hires-mp")     => { /* HiRes専用・最小位相 */ }
        Some("sinc-hb")           => { /* ハーフバンド */ }
        Some("sinc-hb-l")         => { /* ハーフバンド・長 */ }
        Some("sinc-mega")         => { /* 100万タップ（Phase 4以降） */ }
        Some("sinc-ultra")        => { /* 超高タップ数（Phase 4以降） */ }
        Some("fir-lp")            => { /* 標準FIR・線形位相 */ }
        Some("fir-mp")            => { /* 最小位相FIR */ }
        Some("fir-asym")          => { /* 非対称FIR */ }
        Some("fir-minring-lp")    => { /* 最小リンギング・線形 */ }
        Some("fir-minring-mp")    => { /* 最小リンギング・最小位相 */ }
        Some("fft")               => { /* FFTブリックウォール */ }
        Some("bypass") | None     => { /* リサンプリングなし */ }
        _                         => { /* デフォルト: sinc-m-mp */ }
    }
}
```

### rubatoのwrapper（Phase 1暫定実装）

既存の `build_hq_resampler_params` と `SincFixedIn` のロジックをそのまま
`RubatoOversamplingFilter` にwrapする。
Phase 3完了後にこのwrapperを差し替えるだけでよい状態にする。

```rust
pub struct RubatoOversamplingFilter {
    filter_id: &'static str,
    resampler: SincFixedIn<f32>,
    channels: usize,
    ratio: f64,
    // rubato用の中間バッファ（planar形式）
    input_buf: Vec<Vec<f32>>,
    output_buf: Vec<Vec<f32>>,
}

impl OversamplingFilter for RubatoOversamplingFilter {
    // process_chunk内でinterleaved→planar変換→rubato→planar→interleavedを行う
}
```

### wasapi_exclusive.rsの変更点

producerスレッド内の以下の箇所を差し替える：

```rust
// 変更前
let mut resampler = SincFixedIn::<f32>::new(ratio, ...);

// 変更後
let mut filter = registry::create_filter(
    oversampling_filter_id.as_deref(),
    source_sample_rate,
    output_sample_rate,
    channels,
);
```

`process_chunk`の呼び出しも同様に変更する。
`HqResamplerProfile`、`build_hq_resampler_params`、`hq_pending_multiplier`等の
rubato固有コードはPhase 1では残す（Phase 3で除去）。

---

## Phase 2: 係数設計モジュール

### 配置

```
native/engine/src/oversampling/
  coefficients.rs  ← フィルタ係数の計算
```

### 設計方針

- 係数はf64精度で計算し、f32に変換して使用する
- 窓関数はBlackman-Harris（4項）をデフォルトとし、Gaussianも対応する
- 係数はキャッシュライン境界（64byte）にアラインして確保する
- 係数ベクタはArc<[f32]>で保持し、同一設定なら複数フィルタインスタンスで共有できるようにする

### 公開インターフェース

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum WindowFunction {
    BlackmanHarris,   // デフォルト、汎用
    Gaussian { sigma: f64 }, // poly-sinc-gauss系
}

#[derive(Debug, Clone)]
pub struct FilterSpec {
    /// タップ数（奇数推奨）
    pub num_taps: usize,
    /// カットオフ周波数（ナイキスト比、0.0〜1.0）
    pub cutoff: f64,
    /// ポリフェーズのサブフィルタ数（補間精度）
    pub oversampling_factor: usize,
    /// 窓関数
    pub window: WindowFunction,
}

impl FilterSpec {
    /// プロファイルIDと変換レシオからスペックを生成する
    pub fn from_filter_id(filter_id: &str, ratio: f64) -> Self { ... }

    /// ポリフェーズ係数行列を計算して返す
    /// shape: [oversampling_factor][num_taps]
    /// アライメント: 64byteアライン
    pub fn compute_polyphase_coefficients(&self) -> Vec<Vec<f32>> { ... }
}
```

### フィルタID→スペック対応表

以下のパラメータはPhase 1のrubatoパラメータと整合を取ること（測定で検証済みの値）。

| filter_id | ratio >= 8.0 | ratio >= 4.0 | ratio < 4.0 |
|-----------|-------------|-------------|-------------|
| `sinc-s-mp` | (18, 0.885, 4) | (20, 0.890, 5) | (24, 0.900, 6) |
| `sinc-m-mp` | (32, 0.915, 6) | (36, 0.925, 7) | (44, 0.935, 8) |
| `sinc-m-lp` | (56, 0.945, 8) | (72, 0.952, 10) | (88, 0.958, 12) |
| `sinc-l-lp` | (512, 0.968, 64) | (256, 0.968, 32) | (192, 0.968, 20) |

表の値は `(num_taps, cutoff, oversampling_factor)` を示す。
Phase 2初期実装ではこの4種を優先実装する。残りのフィルタはPhase 3以降で追加する。
窓関数はBlackmanHarrisをデフォルト、`-gauss`系はGaussianを使用する。

---

## 品質検証

Phase 2完了後、既存の `offline-oversampling-lab` を使って以下を確認する：

- `stopbandAttenuationDb` がpoly-sinc-long-lpで-120 dB以上であること
- `passbandPeakDb` がゲイン補正後に±0.5 dB以内であること
- `selfNulls.bitExact` がtrueであること（同一フィルタ同士で完全一致）
- rubatoのwrapperと自前実装のSNR比較（`gainMatchedSnrDb`が-80 dB以下 = ほぼ一致）

## 実時間性能ゲート

排他再生（WASAPI exclusive）での実時間性は以下を最低基準とする。

- `exclusive producer perf` の `computeFactor >= 1.0` を連続維持すること（推奨: `>= 1.1`）
- `exclusive producer perf` の `queueWait` が高い場合（目安: 20%以上）は、`realtimeFactor` はキュー背圧込みの見かけ値として扱い、ボトルネック判定は `computeFactor` を優先する
- `exclusive perf` の `pendingSec(current)` が継続的に 0 近傍へ張り付かないこと
- 5分連続再生で `underrunCount` が実用上問題ない水準であること（目安: 0〜ごく少数）

上記を満たさない場合は、音質評価より先に性能改善を優先する。

---

## 制約・注意事項

- `process_chunk` は producer のホットパスで呼ばれるため、**アロケーション禁止**。
  出力バッファは呼び出し元が事前確保する。
  ただしPhase 1のrubato wrapperはこの制約を満たさなくてよい（Phase 3で解消）。
- `OversamplingFilter` は `Send` を要求するが `Sync` は不要。
  producerスレッドが排他的に所有する。
- Windowsのみビルド対象（`#[cfg(target_os = "windows")]`）は維持する。
  trait定義とcoefficients.rsはplatform非依存でよい。
- rubato依存はPhase 3完了まで `Cargo.toml` から除去しない。

## レイテンシ取り扱い

- `latency_frames()` は「出力レート基準」の遅延フレーム数を返す。
- シーク時・ループ折り返し時は `reset()` 後にレイテンシ分の内部状態を再初期化する。
- UI再生位置（シークバー）計算では、`rendered_frames - current_padding - latency_frames` を基準に補正する。
- offline比較時（null / SNR）は `latency_frames` を考慮したアラインを前提とする。

---

## フィルタID命名体系

命名規則: `{タイプ}-{グレード}-{位相}[-{特性}]`

**グレード**: `s`（short）/ `m`（medium）/ `l`（long）/ `xl`（extra long）/ `hb`（halfband）/ `hires`（HiRes専用）/ `mega`・`ultra`（超長タップ）

**位相**: `lp`（linear phase）/ `mp`（minimum phase）/ `ip`（intermediate phase）

**特性サフィックス**: `gauss`（Gaussian窓）/ `apod`（アポダイジング）/ `ext`・`ext2`（拡張周波数応答）

| filter_id | 対応するHQPlayerフィルタ | 説明 |
|-----------|------------------------|------|
| `bypass` | none | リサンプリングなし |
| `fir-lp` | FIR | 標準FIR・線形位相 |
| `fir-mp` | minphaseFIR | 最小位相FIR |
| `fir-asym` | asymFIR | 非対称FIR |
| `fir-minring-lp` | minringFIR-lp | 最小リンギング・線形位相 |
| `fir-minring-mp` | minringFIR-mp | 最小リンギング・最小位相 |
| `fft` | FFT | 周波数域ブリックウォール |
| `sinc-s-mp` | poly-sinc-shrt-mp | 短・最小位相 |
| `sinc-m-mp` | poly-sinc-mp | 標準・最小位相（デフォルト） |
| `sinc-m-lp` | poly-sinc-lp | 標準・線形位相 |
| `sinc-l-lp` | poly-sinc-long-lp | 長・線形位相 |
| `sinc-l-mp` | poly-sinc-long-mp | 長・最小位相 |
| `sinc-l-ip` | poly-sinc-long-ip | 長・中間位相 |
| `sinc-m-lp-ext` | poly-sinc-ext | 拡張周波数応答 |
| `sinc-m-lp-ext2` | poly-sinc-ext2 | 拡張+高減衰・ナイキスト完全カット |
| `sinc-xl-lp` | poly-sinc-xtr-lp | 極端カットオフ・線形位相 |
| `sinc-xl-mp` | poly-sinc-xtr-mp | 極端カットオフ・最小位相 |
| `sinc-m-gauss` | poly-sinc-gauss | Gaussian窓・標準 |
| `sinc-l-gauss` | poly-sinc-gauss-long | Gaussian窓・長 |
| `sinc-xl-gauss` | poly-sinc-gauss-xl | Gaussian窓・超長 |
| `sinc-xl-gauss-apod` | poly-sinc-gauss-xla | Gaussian窓・アポダイジング |
| `sinc-hires-lp` | poly-sinc-gauss-hires-lp | HiRes専用・線形位相 |
| `sinc-hires-mp` | poly-sinc-gauss-hires-mp | HiRes専用・最小位相 |
| `sinc-hb` | poly-sinc-hb | ハーフバンド |
| `sinc-hb-l` | poly-sinc-hb-l | ハーフバンド・長 |
| `sinc-mega` | sinc-M | 100万タップ（Phase 4以降） |
| `sinc-ultra` | sinc-L | 超高タップ数（Phase 4以降） |
| `iir` | IIR | アナログ風IIR |
| `poly-1` | polynomial-1 | 多項式補間（非推奨） |
| `poly-2` | polynomial-2 | 多項式補間（非推奨） |

---

## Phase 3以降のメモ（実装時に別仕様書を作成）

- **短フィルタ（〜2048タップ）**: ポリフェーズ直接畳み込み、AVX2で8サンプル並列
- **長フィルタ（2048タップ超）**: `rustfft` ベースのoverlap-add
- **パイプライン化**: decode thread → resample thread → EQ thread → render thread、スレッド間は`ringbuf`
- **チャンネル並列**: L/Rを別スレッドで並列フィルタリング（長フィルタ時に有効）
- **バッファプール**: チャンク単位のf32バッファをプール制にしてアロケーションゼロ化
