# Offline Oversampling Lab Spec (apod-v9)

- Date: 2026-03-21
- Report source: `C:\aonsoku\native\engine\offline-lab-apod-v9\report.json`
- Engine: `fft-ola`
- Source: `C:\aonsoku\cypress\fixtures\song.mp3` (`44.1 kHz`, `2ch`)
- Target sample rate (normalized): `352800 Hz` (`384000 -> 352800`)

## Run Command

```powershell
cd C:\aonsoku\native\engine; Remove-Item Env:AONSOKU_APOD_PHASE_BLEND_MODE -ErrorAction SilentlyContinue; cargo run --release --bin offline-oversampling-lab -- --src "C:\aonsoku\cypress\fixtures\song.mp3" --filters "sinc-ultra,sinc-ultra-apod,sinc-mega,sinc-mega-apod" --reference-filter "sinc-ultra" --target-sample-rate 384000 --output-dir "C:\aonsoku\native\engine\offline-lab-apod-v9" --self-null --analyze-impulse --impulse-frames 131072 --stopband-start-hz 22050
```

## Filter Params

- `sinc-ultra`: `sincLen=4096`, `cutoff=0.488000`, `osf=8`, `chunkFrames=4096`
- `sinc-ultra-apod`: `sincLen=4096`, `cutoff=0.488000`, `osf=8`, `chunkFrames=4096`
- `sinc-mega`: `sincLen=2048`, `cutoff=0.487000`, `osf=8`, `chunkFrames=4096`
- `sinc-mega-apod`: `sincLen=2048`, `cutoff=0.487000`, `osf=8`, `chunkFrames=4096`

## Cases

| Filter | Output Hz | Processing ms | Peak dBFS | RMS dBFS | Crest dB | Clip Samples | Clip Ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| `sinc-ultra` | 352800 | 1107.3612 | 0.857563 | -10.850154 | 11.707717 | 115 | 7.8662e-7 |
| `sinc-ultra-apod` | 352800 | 1502.6551 | 0.025426 | -11.976753 | 12.002179 | 2 | 1.3680e-8 |
| `sinc-mega` | 352800 | 886.5040 | 0.857134 | -10.849180 | 11.706314 | 115 | 7.8680e-7 |
| `sinc-mega-apod` | 352800 | 933.5248 | 0.151821 | -11.701170 | 11.852991 | 9 | 6.1576e-8 |

## Impulse Analysis

| Filter | Passband Peak dB | Stopband Peak Hz | Stopband Peak dB | Stopband Atten dB | Stopband P95 Atten dB |
|---|---:|---:|---:|---:|---:|
| `sinc-ultra` | 17.049600 | 22059.2525 | -119.014491 | -136.064091 | -145.978687 |
| `sinc-ultra-apod` | 17.049599 | 22090.7112 | -121.748549 | -138.798148 | -146.054792 |
| `sinc-mega` | 17.049600 | 22406.1390 | -121.067666 | -138.117266 | -145.587168 |
| `sinc-mega-apod` | 17.049600 | 22122.3381 | -121.175239 | -138.224839 | -143.463600 |

## Comparisons (Reference: `sinc-ultra`)

| Filter | Lag Frames | Correlation | Level Delta dB | Residual RMS Rel dB | Gain-Matched SNR dB |
|---|---:|---:|---:|---:|---:|
| `sinc-ultra-apod` | 0 | 0.990687 | -1.126599 | -15.064295 | 18.445591 |
| `sinc-mega` | -1081 | 0.148002 | ~0.000000 | 2.314688 | 0.096187 |
| `sinc-mega-apod` | -624 | 0.115466 | -0.851990 | 2.075027 | 0.910281 |

## Self Null

- `sinc-ultra`: `bitExact=true`
- `sinc-ultra-apod`: `bitExact=true`
- `sinc-mega`: `bitExact=true`
- `sinc-mega-apod`: `bitExact=true`

## Summary

- `legacy` apod path with `fft-ola` maintained very high stopband attenuation (`~ -136 dB to -138 dB`).
- `sinc-ultra-apod` / `sinc-mega-apod` reduced peak and clip significantly versus their non-apod variants.
- This report is the baseline spec for the `apod-v9` state.
