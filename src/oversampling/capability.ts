import {
  OVERSAMPLING_ENGINES,
  OVERSAMPLING_PROCESSING_OUTPUT_APIS,
  OversamplingCapability,
  OversamplingEngine,
  OversamplingOutputApi,
} from './types'

const TAP_LIMITS: Record<OversamplingEngine, number> = {
  cpu: 2_097_152,
  gpu: 4_194_304,
}

function dedupeOrdered<T extends string>(
  source: readonly T[],
  allowed: readonly T[],
): T[] {
  const seen = new Set<string>()

  return allowed.filter((value) => {
    if (!source.includes(value)) return false
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

export function createRuntimeOversamplingCapability(params: {
  supportedOutputApis: readonly OversamplingOutputApi[]
  availableEngines?: readonly OversamplingEngine[]
}): OversamplingCapability {
  const supportedOutputApis = dedupeOrdered(
    params.supportedOutputApis,
    OVERSAMPLING_PROCESSING_OUTPUT_APIS,
  )
  const availableEngines = dedupeOrdered(
    params.availableEngines ?? ['cpu'],
    OVERSAMPLING_ENGINES,
  )

  if (availableEngines.length === 0) {
    return {
      supportedOutputApis,
      availableEngines: ['cpu'],
      maxTapCountByEngine: {
        cpu: TAP_LIMITS.cpu,
      },
    }
  }

  const maxTapCountByEngine = availableEngines.reduce<
    NonNullable<OversamplingCapability['maxTapCountByEngine']>
  >((acc, engine) => {
    acc[engine] = TAP_LIMITS[engine]
    return acc
  }, {})

  return {
    supportedOutputApis,
    availableEngines,
    maxTapCountByEngine,
  }
}
