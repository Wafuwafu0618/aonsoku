export const OVERSAMPLING_FILTER_IDS = [
  'poly-sinc-short-mp',
  'poly-sinc-mp',
  'poly-sinc-lp',
  'poly-sinc-long-lp',
  'poly-sinc-long-ip',
  'poly-sinc-gauss',
  'poly-sinc-ext2',
] as const

export type OversamplingFilterId = (typeof OVERSAMPLING_FILTER_IDS)[number]

export const OVERSAMPLING_PRESET_IDS = [
  'poly-sinc-short-mp',
  'poly-sinc-mp',
  'poly-sinc-lp',
  'poly-sinc-long-lp',
  'poly-sinc-long-ip',
  'poly-sinc-gauss',
  'poly-sinc-ext2',
] as const

export type OversamplingPresetId = (typeof OVERSAMPLING_PRESET_IDS)[number]

export const OVERSAMPLING_OUTPUT_APIS = [
  'wasapi-shared',
  'wasapi-exclusive',
  'asio',
] as const

export type OversamplingOutputApi = (typeof OVERSAMPLING_OUTPUT_APIS)[number]

// Oversampling quality path targets exclusive/direct output modes only.
export const OVERSAMPLING_PROCESSING_OUTPUT_APIS = [
  'wasapi-exclusive',
  'asio',
] as const

export const OVERSAMPLING_ENGINES = ['cpu', 'gpu'] as const

export type OversamplingEngine = (typeof OVERSAMPLING_ENGINES)[number]

export const OVERSAMPLING_ENGINE_PREFERENCES = ['auto', 'cpu', 'gpu'] as const

export type OversamplingEnginePreference =
  (typeof OVERSAMPLING_ENGINE_PREFERENCES)[number]

export type OversamplingFailurePolicy = 'stop-and-notify'

export const OVERSAMPLING_TARGET_RATE_POLICIES = [
  'integer-family-max',
  'fixed-88200',
  'fixed-96000',
  'fixed-176400',
  'fixed-192000',
  'fixed-352800',
  'fixed-384000',
  'fixed-705600',
  'fixed-768000',
  'fixed-1411200',
  'fixed-1536000',
] as const

export type OversamplingTargetRatePolicy =
  (typeof OVERSAMPLING_TARGET_RATE_POLICIES)[number]

export type OversamplingFilterPhase =
  | 'minimum'
  | 'linear'
  | 'intermediate'

export interface OversamplingFilterSpec {
  id: OversamplingFilterId
  hqplayerName: string
  phase: OversamplingFilterPhase
  tapCount: number
  supportedEngines: OversamplingEngine[]
  supportedOutputApis: OversamplingOutputApi[]
}

export interface OversamplingPresetSpec {
  id: OversamplingPresetId
  displayName: string
  filterId: OversamplingFilterId
  targetRatePolicy: OversamplingTargetRatePolicy
  preferredEngine: OversamplingEnginePreference
  onFailurePolicy: OversamplingFailurePolicy
}

export interface OversamplingCapability {
  supportedOutputApis: OversamplingOutputApi[]
  availableEngines: OversamplingEngine[]
  maxTapCountByEngine?: Partial<Record<OversamplingEngine, number>>
}

export interface OversamplingSettingsValues {
  enabled: boolean
  presetId: OversamplingPresetId
  targetRatePolicy: OversamplingTargetRatePolicy
  enginePreference: OversamplingEnginePreference
  outputApi: OversamplingOutputApi
  onFailurePolicy: OversamplingFailurePolicy
}

export type OversamplingResolveFailureCode =
  | 'preset-not-found'
  | 'filter-not-found'
  | 'output-api-not-supported'
  | 'engine-not-available'
  | 'engine-not-supported-by-filter'
  | 'tap-count-exceeded'

export interface OversamplingResolveFailure {
  code: OversamplingResolveFailureCode
  message: string
  details?: Record<string, unknown>
}

export interface ResolvedOversamplingConfig {
  preset: OversamplingPresetSpec
  filter: OversamplingFilterSpec
  targetRatePolicy: OversamplingTargetRatePolicy
  selectedEngine: OversamplingEngine
  outputApi: OversamplingOutputApi
  onFailurePolicy: OversamplingFailurePolicy
}

export type OversamplingResolveResult =
  | { ok: true; value: ResolvedOversamplingConfig }
  | { ok: false; error: OversamplingResolveFailure }
