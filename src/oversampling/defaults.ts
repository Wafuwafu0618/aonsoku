import {
  OversamplingCapability,
  OversamplingSettingsValues,
} from './types'

export const DEFAULT_OVERSAMPLING_SETTINGS: OversamplingSettingsValues = {
  enabled: false,
  presetId: 'poly-sinc-mp',
  enginePreference: 'auto',
  outputApi: 'wasapi-shared',
  onFailurePolicy: 'stop-and-notify',
}

export const DEFAULT_OVERSAMPLING_CAPABILITY: OversamplingCapability = {
  supportedOutputApis: ['wasapi-shared'],
  availableEngines: ['cpu'],
  maxTapCountByEngine: {
    cpu: 65536,
  },
}

export const createDefaultOversamplingSettings = (): OversamplingSettingsValues =>
  ({
    ...DEFAULT_OVERSAMPLING_SETTINGS,
  })

export const createDefaultOversamplingCapability = (): OversamplingCapability => ({
  supportedOutputApis: [...DEFAULT_OVERSAMPLING_CAPABILITY.supportedOutputApis],
  availableEngines: [...DEFAULT_OVERSAMPLING_CAPABILITY.availableEngines],
  maxTapCountByEngine: DEFAULT_OVERSAMPLING_CAPABILITY.maxTapCountByEngine
    ? { ...DEFAULT_OVERSAMPLING_CAPABILITY.maxTapCountByEngine }
    : undefined,
})
