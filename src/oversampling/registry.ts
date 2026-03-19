import {
  OVERSAMPLING_FILTER_IDS,
  OVERSAMPLING_PRESET_IDS,
  OversamplingFilterId,
  OversamplingFilterSpec,
  OversamplingPresetId,
  OversamplingPresetSpec,
} from './types'

export const OVERSAMPLING_FILTER_REGISTRY: Record<
  OversamplingFilterId,
  OversamplingFilterSpec
> = {
  'poly-sinc-short-mp': {
    id: 'poly-sinc-short-mp',
    hqplayerName: 'poly-sinc-short-mp',
    phase: 'minimum',
    tapCount: 16384,
    supportedEngines: ['cpu', 'gpu'],
    supportedOutputApis: ['wasapi-shared', 'wasapi-exclusive', 'asio'],
  },
  'poly-sinc-mp': {
    id: 'poly-sinc-mp',
    hqplayerName: 'poly-sinc-mp',
    phase: 'minimum',
    tapCount: 65536,
    supportedEngines: ['cpu', 'gpu'],
    supportedOutputApis: ['wasapi-shared', 'wasapi-exclusive', 'asio'],
  },
  'poly-sinc-ext2': {
    id: 'poly-sinc-ext2',
    hqplayerName: 'poly-sinc-ext2',
    phase: 'minimum',
    tapCount: 131072,
    supportedEngines: ['cpu', 'gpu'],
    supportedOutputApis: ['wasapi-exclusive', 'asio'],
  },
}

export const OVERSAMPLING_PRESET_REGISTRY: Record<
  OversamplingPresetId,
  OversamplingPresetSpec
> = {
  'poly-sinc-short-mp': {
    id: 'poly-sinc-short-mp',
    displayName: 'poly-sinc-short-mp',
    filterId: 'poly-sinc-short-mp',
    targetRatePolicy: 'integer-family-max',
    preferredEngine: 'cpu',
    onFailurePolicy: 'stop-and-notify',
  },
  'poly-sinc-mp': {
    id: 'poly-sinc-mp',
    displayName: 'poly-sinc-mp',
    filterId: 'poly-sinc-mp',
    targetRatePolicy: 'integer-family-max',
    preferredEngine: 'auto',
    onFailurePolicy: 'stop-and-notify',
  },
  'poly-sinc-ext2': {
    id: 'poly-sinc-ext2',
    displayName: 'poly-sinc-ext2',
    filterId: 'poly-sinc-ext2',
    targetRatePolicy: 'integer-family-max',
    preferredEngine: 'gpu',
    onFailurePolicy: 'stop-and-notify',
  },
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
  OVERSAMPLING_PRESET_IDS.map((id) => OVERSAMPLING_PRESET_REGISTRY[id])
