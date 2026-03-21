import {
  OVERSAMPLING_FILTER_IDS,
  OVERSAMPLING_LEGACY_PRESET_IDS,
  OVERSAMPLING_PRESET_IDS,
  OversamplingFilterId,
  OversamplingFilterPhase,
  OversamplingFilterSpec,
  OversamplingPresetId,
  OversamplingPresetSpec,
} from './types'

const SUPPORTED_ENGINES: OversamplingFilterSpec['supportedEngines'] = ['cpu', 'gpu']
const SUPPORTED_OUTPUT_APIS: OversamplingFilterSpec['supportedOutputApis'] = [
  'wasapi-exclusive',
  'asio',
]

const createFilter = (
  id: OversamplingFilterId,
  hqplayerName: string,
  phase: OversamplingFilterPhase,
  tapCount: number,
): OversamplingFilterSpec => ({
  id,
  hqplayerName,
  phase,
  tapCount,
  supportedEngines: [...SUPPORTED_ENGINES],
  supportedOutputApis: [...SUPPORTED_OUTPUT_APIS],
})

export const OVERSAMPLING_FILTER_REGISTRY: Record<
  OversamplingFilterId,
  OversamplingFilterSpec
> = {
  bypass: createFilter('bypass', 'none', 'linear', 0),
  'fir-lp': createFilter('fir-lp', 'FIR', 'linear', 65536),
  'fir-mp': createFilter('fir-mp', 'minphaseFIR', 'minimum', 65536),
  'fir-asym': createFilter('fir-asym', 'asymFIR', 'intermediate', 65536),
  'fir-minring-lp': createFilter('fir-minring-lp', 'minringFIR-lp', 'linear', 65536),
  'fir-minring-mp': createFilter('fir-minring-mp', 'minringFIR-mp', 'minimum', 65536),
  fft: createFilter('fft', 'FFT', 'linear', 131072),
  'sinc-s-mp': createFilter('sinc-s-mp', 'poly-sinc-shrt-mp', 'minimum', 16384),
  'sinc-m-mp': createFilter('sinc-m-mp', 'poly-sinc-mp', 'minimum', 65536),
  'sinc-m-lp': createFilter('sinc-m-lp', 'poly-sinc-lp', 'linear', 65536),
  'sinc-l-lp': createFilter('sinc-l-lp', 'poly-sinc-long-lp', 'linear', 262144),
  'sinc-l-mp': createFilter('sinc-l-mp', 'poly-sinc-long-mp', 'minimum', 262144),
  'sinc-l-ip': createFilter('sinc-l-ip', 'poly-sinc-long-ip', 'intermediate', 262144),
  'sinc-m-lp-ext': createFilter('sinc-m-lp-ext', 'poly-sinc-ext', 'linear', 98304),
  'sinc-m-lp-ext2': createFilter('sinc-m-lp-ext2', 'poly-sinc-ext2', 'linear', 131072),
  'sinc-xl-lp': createFilter('sinc-xl-lp', 'poly-sinc-xtr-lp', 'linear', 524288),
  'sinc-xl-mp': createFilter('sinc-xl-mp', 'poly-sinc-xtr-mp', 'minimum', 524288),
  'sinc-m-gauss': createFilter('sinc-m-gauss', 'poly-sinc-gauss', 'linear', 65536),
  'sinc-l-gauss': createFilter('sinc-l-gauss', 'poly-sinc-gauss-long', 'linear', 262144),
  'sinc-xl-gauss': createFilter('sinc-xl-gauss', 'poly-sinc-gauss-xl', 'linear', 524288),
  'sinc-xl-gauss-apod': createFilter('sinc-xl-gauss-apod', 'poly-sinc-gauss-xla', 'linear', 524288),
  'sinc-hires-lp': createFilter('sinc-hires-lp', 'poly-sinc-gauss-hires-lp', 'linear', 524288),
  'sinc-hires-mp': createFilter('sinc-hires-mp', 'poly-sinc-gauss-hires-mp', 'minimum', 524288),
  'sinc-hb': createFilter('sinc-hb', 'poly-sinc-hb', 'linear', 131072),
  'sinc-hb-l': createFilter('sinc-hb-l', 'poly-sinc-hb-l', 'linear', 262144),
  'sinc-mega': createFilter('sinc-mega', 'sinc-M', 'linear', 1_048_576),
  'sinc-ultra': createFilter('sinc-ultra', 'sinc-L', 'linear', 2_097_152),
  iir: createFilter('iir', 'IIR', 'minimum', 4096),
  'poly-1': createFilter('poly-1', 'polynomial-1', 'minimum', 2048),
  'poly-2': createFilter('poly-2', 'polynomial-2', 'minimum', 4096),

  // Legacy HQ-style IDs kept for backward compatibility.
  'poly-sinc-short-mp': createFilter('poly-sinc-short-mp', 'poly-sinc-shrt-mp', 'minimum', 16384),
  'poly-sinc-mp': createFilter('poly-sinc-mp', 'poly-sinc-mp', 'minimum', 65536),
  'poly-sinc-lp': createFilter('poly-sinc-lp', 'poly-sinc-lp', 'linear', 65536),
  'poly-sinc-long-lp': createFilter('poly-sinc-long-lp', 'poly-sinc-long-lp', 'linear', 262144),
  'poly-sinc-long-ip': createFilter('poly-sinc-long-ip', 'poly-sinc-long-ip', 'intermediate', 262144),
  'poly-sinc-gauss': createFilter('poly-sinc-gauss', 'poly-sinc-gauss', 'linear', 65536),
  'poly-sinc-ext2': createFilter('poly-sinc-ext2', 'poly-sinc-ext2', 'linear', 131072),
}

const createPreset = (
  id: OversamplingPresetId,
  filterId: OversamplingFilterId,
): OversamplingPresetSpec => ({
  id,
  displayName: id,
  filterId,
  targetRatePolicy: 'integer-family-max',
  preferredEngine: 'auto',
  onFailurePolicy: 'stop-and-notify',
})

export const OVERSAMPLING_PRESET_REGISTRY: Record<
  OversamplingPresetId,
  OversamplingPresetSpec
> = {
  'fir-lp': createPreset('fir-lp', 'fir-lp'),
  'fir-mp': createPreset('fir-mp', 'fir-mp'),
  'fir-asym': createPreset('fir-asym', 'fir-asym'),
  'fir-minring-lp': createPreset('fir-minring-lp', 'fir-minring-lp'),
  'fir-minring-mp': createPreset('fir-minring-mp', 'fir-minring-mp'),
  fft: createPreset('fft', 'fft'),
  'sinc-s-mp': createPreset('sinc-s-mp', 'sinc-s-mp'),
  'sinc-m-mp': createPreset('sinc-m-mp', 'sinc-m-mp'),
  'sinc-m-lp': createPreset('sinc-m-lp', 'sinc-m-lp'),
  'sinc-l-lp': createPreset('sinc-l-lp', 'sinc-l-lp'),
  'sinc-l-mp': createPreset('sinc-l-mp', 'sinc-l-mp'),
  'sinc-l-ip': createPreset('sinc-l-ip', 'sinc-l-ip'),
  'sinc-m-lp-ext': createPreset('sinc-m-lp-ext', 'sinc-m-lp-ext'),
  'sinc-m-lp-ext2': createPreset('sinc-m-lp-ext2', 'sinc-m-lp-ext2'),
  'sinc-xl-lp': createPreset('sinc-xl-lp', 'sinc-xl-lp'),
  'sinc-xl-mp': createPreset('sinc-xl-mp', 'sinc-xl-mp'),
  'sinc-m-gauss': createPreset('sinc-m-gauss', 'sinc-m-gauss'),
  'sinc-l-gauss': createPreset('sinc-l-gauss', 'sinc-l-gauss'),
  'sinc-xl-gauss': createPreset('sinc-xl-gauss', 'sinc-xl-gauss'),
  'sinc-xl-gauss-apod': createPreset('sinc-xl-gauss-apod', 'sinc-xl-gauss-apod'),
  'sinc-hires-lp': createPreset('sinc-hires-lp', 'sinc-hires-lp'),
  'sinc-hires-mp': createPreset('sinc-hires-mp', 'sinc-hires-mp'),
  'sinc-hb': createPreset('sinc-hb', 'sinc-hb'),
  'sinc-hb-l': createPreset('sinc-hb-l', 'sinc-hb-l'),
  'sinc-mega': createPreset('sinc-mega', 'sinc-mega'),
  'sinc-ultra': createPreset('sinc-ultra', 'sinc-ultra'),
  iir: createPreset('iir', 'iir'),
  'poly-1': createPreset('poly-1', 'poly-1'),
  'poly-2': createPreset('poly-2', 'poly-2'),

  // Legacy presets are intentionally retained so existing persisted settings keep working.
  'poly-sinc-short-mp': createPreset('poly-sinc-short-mp', 'poly-sinc-short-mp'),
  'poly-sinc-mp': createPreset('poly-sinc-mp', 'poly-sinc-mp'),
  'poly-sinc-lp': createPreset('poly-sinc-lp', 'poly-sinc-lp'),
  'poly-sinc-long-lp': createPreset('poly-sinc-long-lp', 'poly-sinc-long-lp'),
  'poly-sinc-long-ip': createPreset('poly-sinc-long-ip', 'poly-sinc-long-ip'),
  'poly-sinc-gauss': createPreset('poly-sinc-gauss', 'poly-sinc-gauss'),
  'poly-sinc-ext2': createPreset('poly-sinc-ext2', 'poly-sinc-ext2'),
}

export const getOversamplingFilterById = (
  id: OversamplingFilterId,
): OversamplingFilterSpec | undefined => OVERSAMPLING_FILTER_REGISTRY[id]

export const getOversamplingPresetById = (
  id: OversamplingPresetId,
): OversamplingPresetSpec | undefined => OVERSAMPLING_PRESET_REGISTRY[id]

export const listOversamplingFilters = (): OversamplingFilterSpec[] =>
  OVERSAMPLING_FILTER_IDS.map((id) => OVERSAMPLING_FILTER_REGISTRY[id])

export const listOversamplingPresets = (): OversamplingPresetSpec[] =>
  [...OVERSAMPLING_PRESET_IDS, ...OVERSAMPLING_LEGACY_PRESET_IDS].map(
    (id) => OVERSAMPLING_PRESET_REGISTRY[id],
  )
