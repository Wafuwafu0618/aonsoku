import { getOversamplingFilterById, getOversamplingPresetById } from './registry'
import {
  OVERSAMPLING_ENGINES,
  OversamplingCapability,
  OversamplingEngine,
  OversamplingResolveResult,
  OversamplingSettingsValues,
} from './types'

const appendUniqueEngine = (
  engines: OversamplingEngine[],
  candidate: OversamplingEngine,
): void => {
  if (!engines.includes(candidate)) {
    engines.push(candidate)
  }
}

const buildEnginePriority = (
  settings: OversamplingSettingsValues,
  presetPreferredEngine: OversamplingSettingsValues['enginePreference'],
): OversamplingEngine[] => {
  const priority: OversamplingEngine[] = []

  if (settings.enginePreference !== 'auto') {
    appendUniqueEngine(priority, settings.enginePreference)
  }

  if (settings.enginePreference === 'auto' && presetPreferredEngine !== 'auto') {
    appendUniqueEngine(priority, presetPreferredEngine)
  }

  for (const engine of OVERSAMPLING_ENGINES) {
    appendUniqueEngine(priority, engine)
  }

  return priority
}

export const resolveOversamplingConfig = (
  settings: OversamplingSettingsValues,
  capability: OversamplingCapability,
): OversamplingResolveResult => {
  const preset = getOversamplingPresetById(settings.presetId)
  if (!preset) {
    return {
      ok: false,
      error: {
        code: 'preset-not-found',
        message: `Oversampling preset not found: ${settings.presetId}`,
        details: { presetId: settings.presetId },
      },
    }
  }

  const filter = getOversamplingFilterById(preset.filterId)
  if (!filter) {
    return {
      ok: false,
      error: {
        code: 'filter-not-found',
        message: `Oversampling filter not found: ${preset.filterId}`,
        details: { presetId: preset.id, filterId: preset.filterId },
      },
    }
  }

  if (
    !capability.supportedOutputApis.includes(settings.outputApi) ||
    !filter.supportedOutputApis.includes(settings.outputApi)
  ) {
    return {
      ok: false,
      error: {
        code: 'output-api-not-supported',
        message: `Output API not supported for current capability/filter: ${settings.outputApi}`,
        details: {
          outputApi: settings.outputApi,
          capabilityOutputApis: capability.supportedOutputApis,
          filterOutputApis: filter.supportedOutputApis,
        },
      },
    }
  }

  const enginePriority = buildEnginePriority(
    settings,
    preset.preferredEngine,
  )

  const availableEngines = enginePriority.filter((engine) =>
    capability.availableEngines.includes(engine),
  )
  if (availableEngines.length === 0) {
    return {
      ok: false,
      error: {
        code: 'engine-not-available',
        message: 'No oversampling engine is available in current capability.',
        details: {
          requestedEnginePreference: settings.enginePreference,
          availableEngines: capability.availableEngines,
        },
      },
    }
  }

  const filterSupportedEngines = availableEngines.filter((engine) =>
    filter.supportedEngines.includes(engine),
  )

  if (filterSupportedEngines.length === 0) {
    return {
      ok: false,
      error: {
        code: 'engine-not-supported-by-filter',
        message: `Filter ${filter.id} does not support available engines.`,
        details: {
          filterId: filter.id,
          filterSupportedEngines: filter.supportedEngines,
          availableEngines,
        },
      },
    }
  }

  const tapCompatibleEngines = filterSupportedEngines.filter((engine) => {
    const maxTapCount = capability.maxTapCountByEngine?.[engine]
    return maxTapCount === undefined || filter.tapCount <= maxTapCount
  })

  if (tapCompatibleEngines.length === 0) {
    return {
      ok: false,
      error: {
        code: 'tap-count-exceeded',
        message: `Filter tap count exceeds capability limits for ${preset.id}.`,
        details: {
          filterId: filter.id,
          tapCount: filter.tapCount,
          maxTapCountByEngine: capability.maxTapCountByEngine,
        },
      },
    }
  }

  return {
    ok: true,
    value: {
      preset,
      filter,
      targetRatePolicy: settings.targetRatePolicy,
      selectedEngine: tapCompatibleEngines[0],
      outputApi: settings.outputApi,
      onFailurePolicy: settings.onFailurePolicy,
    },
  }
}
