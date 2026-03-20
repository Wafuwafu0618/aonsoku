import {
  PARAMETRIC_EQ_FILTER_TYPES,
  ParametricEqBand,
  ParametricEqFilterType,
  ParsedParametricEq,
} from './types'

const PREAMP_LINE_REGEX = /^Preamp:\s*([+-]?\d+(?:\.\d+)?)\s*dB\s*$/i
const FILTER_LINE_REGEX =
  /^Filter\s+(\d+):\s*(ON|OFF)\s+([A-Z]+)\s+Fc\s+([+-]?\d+(?:\.\d+)?)\s*Hz\s+Gain\s+([+-]?\d+(?:\.\d+)?)\s*dB\s+Q\s+([+-]?\d+(?:\.\d+)?)\s*$/i

const SUPPORTED_FILTER_TYPES = new Set<string>(PARAMETRIC_EQ_FILTER_TYPES)

function parseFiniteNumber(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`${label} must be a finite number`)
  }

  return parsed
}

function parseBand(line: string): ParametricEqBand | null {
  const match = line.match(FILTER_LINE_REGEX)
  if (!match) {
    return null
  }

  const [, indexRaw, enabledRaw, typeRaw, frequencyRaw, gainRaw, qRaw] = match
  const type = typeRaw.toUpperCase()

  if (!SUPPORTED_FILTER_TYPES.has(type)) {
    return null
  }

  const frequencyHz = parseFiniteNumber(frequencyRaw, 'frequencyHz')
  const gainDb = parseFiniteNumber(gainRaw, 'gainDb')
  const q = parseFiniteNumber(qRaw, 'q')
  const index = Math.trunc(parseFiniteNumber(indexRaw, 'index'))

  if (index <= 0) {
    throw new Error('Filter index must be greater than 0')
  }
  if (frequencyHz <= 0) {
    throw new Error('Filter frequency must be greater than 0 Hz')
  }
  if (q <= 0) {
    throw new Error('Filter Q must be greater than 0')
  }

  return {
    index,
    enabled: enabledRaw.toUpperCase() === 'ON',
    type: type as ParametricEqFilterType,
    frequencyHz,
    gainDb,
    q,
  }
}

export function parseParametricEqText(content: string): ParsedParametricEq {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let preampDb = 0
  let preampParsed = false
  const bands: ParametricEqBand[] = []
  const warnings: string[] = []

  for (const line of lines) {
    if (line.startsWith('#')) {
      continue
    }

    const preampMatch = line.match(PREAMP_LINE_REGEX)
    if (preampMatch) {
      preampDb = parseFiniteNumber(preampMatch[1], 'preampDb')
      preampParsed = true
      continue
    }

    const filterMatch = line.match(FILTER_LINE_REGEX)
    if (filterMatch) {
      const type = filterMatch[3].toUpperCase()
      if (!SUPPORTED_FILTER_TYPES.has(type)) {
        warnings.push(`Unsupported filter type skipped: ${type}`)
        continue
      }

      const band = parseBand(line)
      if (band) {
        bands.push(band)
      }
      continue
    }

    warnings.push(`Unrecognized line skipped: ${line}`)
  }

  if (!preampParsed) {
    warnings.push('Preamp is missing. 0 dB is used.')
  }

  const enabledBands = bands.filter((band) => band.enabled)
  if (enabledBands.length === 0) {
    throw new Error('No enabled filters were found in the imported file.')
  }

  return {
    preampDb,
    bands: enabledBands.sort((a, b) => a.index - b.index),
    warnings,
  }
}
