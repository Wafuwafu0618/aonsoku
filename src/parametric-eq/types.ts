export const PARAMETRIC_EQ_FILTER_TYPES = ['PK', 'LSC', 'HSC'] as const

export type ParametricEqFilterType = (typeof PARAMETRIC_EQ_FILTER_TYPES)[number]

export interface ParametricEqBand {
  index: number
  enabled: boolean
  type: ParametricEqFilterType
  frequencyHz: number
  gainDb: number
  q: number
}

export interface ParametricEqProfile {
  name: string
  sourcePath: string
  importedAt: number
  preampDb: number
  bands: ParametricEqBand[]
}

export interface ParsedParametricEq {
  preampDb: number
  bands: ParametricEqBand[]
  warnings: string[]
}
