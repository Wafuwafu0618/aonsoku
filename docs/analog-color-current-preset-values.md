# Analog Color 現在プリセット値（Low+Mid Band Tube）

最終更新: 2026-03-28  
実装参照: `native/engine/src/audio/analog_color.rs`

## 1. プリセット実数値

`*_drive_linear = 10^(*_drive_db/20)`  
`*_makeup_linear = 10^(*_makeup_db/20)`  
`output_trim_linear = 10^(output_trim_db/20)`

| Preset | low_drive_db | low_drive_linear | low_bias | low_mix | low_makeup_db | low_makeup_linear | mid_drive_db | mid_drive_linear | mid_bias | mid_mix | mid_makeup_db | mid_makeup_linear | output_trim_db | output_trim_linear | low_band_cutoff_hz | mid_band_cutoff_hz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `light` | `+4.0` | `1.5849` | `0.10` | `0.30` | `+0.25` | `1.0292` | `+1.8` | `1.2303` | `0.05` | `0.12` | `+0.06` | `1.0069` | `-0.8` | `0.9120` | `180` | `1400` |
| `standard` | `+6.0` | `1.9953` | `0.15` | `0.45` | `+0.45` | `1.0532` | `+2.6` | `1.3490` | `0.08` | `0.18` | `+0.12` | `1.0139` | `-1.3` | `0.8607` | `220` | `1700` |
| `strong` | `+8.5` | `2.6607` | `0.22` | `0.62` | `+0.55` | `1.0654` | `+3.8` | `1.5488` | `0.11` | `0.25` | `+0.18` | `1.0209` | `-2.3` | `0.7670` | `280` | `2200` |

補足:
- 低域が主役で、中域は控えめに偶数次を追加する設計。
- 高域は非線形処理せず、分離したまま再合成。

## 2. 処理順

1. 低域抽出（1-pole low-pass, `low_band_cutoff_hz`）  
2. 中域までの抽出（1-pole low-pass, `mid_band_cutoff_hz`）  
3. `low = low_lp`, `mid = mid_lp - low_lp`, `high = input - mid_lp` で3帯域分離  
4. 低域バンドに `tanh` 非線形（`low_bias` で偶数次を誘導）  
5. 中域バンドに軽めの `tanh` 非線形（`mid_bias`）  
6. 低域/中域それぞれに DC blocker（1-pole high-pass）  
7. 低域/中域にそれぞれ `*_makeup` を適用  
8. `low + mid + high` を再合成し、最後に `output_trim`

## 3. サンプルレート依存パラメータ

### low-pass 係数（low/mid 共通式）
`alpha = 1 - exp(-2π*cutoff_hz/sample_rate_hz)`

### DC blocker 係数
`r = exp(-2π*8.0/sample_rate_hz)`  
（DC blocker のカットオフは 8Hz 固定）

44.1kHz 時の目安:
- `alpha` (`180Hz`) ≈ `0.0253`
- `alpha` (`220Hz`) ≈ `0.0309`
- `alpha` (`280Hz`) ≈ `0.0391`
- `alpha` (`1400Hz`) ≈ `0.1808`
- `alpha` (`1700Hz`) ≈ `0.2152`
- `alpha` (`2200Hz`) ≈ `0.2690`
- `r` (`8Hz`) ≈ `0.99886`

## 4. 聴感との対応

- `low_*`: 低域側の質感と厚みの決定要素
- `mid_*`: 中域側の温度感/密度の付加（低域より弱め）
- `output_trim`: 全帯域の最終レベル抑制
- `low_band_cutoff_hz`: 低域バンド上限の目安
- `mid_band_cutoff_hz`: 中域バンド上限（この上は高域としてクリーン保持）
