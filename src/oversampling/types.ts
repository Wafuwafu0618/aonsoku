export const OVERSAMPLING_FILTER_IDS = [
  'poly-sinc-short-mp',
  'poly-sinc-mp',
  'poly-sinc-ext2',
] as const

export type OversamplingFilterId = (typeof OVERSAMPLING_FILTER_IDS)[number]

export const OVERSAMPLING_PRESET_IDS = [
  'poly-sinc-short-mp',
  'poly-sinc-mp',
  'poly-sinc-ext2',
] as const

export type OversamplingPresetId = (typeof OVERSAMPLING_PRESET_IDS)[number]

export const OVERSAMPLING_OUTPUT_APIS = [
  'wasapi-shared',
  'wasapi-exclusive',
  'asio',
] as const

export type OversamplingOutputApi = (typeof OVERSAMPLING_OUTPUT_APIS)[number]

export const OVERSAMPLING_ENGINES = ['cpu', 'gpu'] as const

export type OversamplingEngine = (typeof OVERSAMPLING_ENGINES)[number]

export const OVERSAMPLING_ENGINE_PREFERENCES = ['auto', 'cpu', 'gpu'] as const

export type OversamplingEnginePreference =
  (typeof OVERSAMPLING_ENGINE_PREFERENCES)[number]

export type OversamplingFailurePolicy = 'stop-and-notify'

export interface OversamplingFilterSpec {
  id: OversamplingFilterId
  hqplayerName: string
  phase: 'minimum'
  tapCount: number
  supportedEngines: OversamplingEngine[]
  supportedOutputApis: OversamplingOutputApi[]
}

export interface OversamplingPresetSpec {
  id: OversamplingPresetId
  displayName: string
  filterId: OversamplingFilterId
  targetRatePolicy: 'integer-family-max'
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
  selectedEngine: OversamplingEngine
  outputApi: OversamplingOutputApi
  onFailurePolicy: OversamplingFailurePolicy
}

export type OversamplingResolveResult =
  | { ok: true; value: ResolvedOversamplingConfig }
  | { ok: false; error: OversamplingResolveFailure }
