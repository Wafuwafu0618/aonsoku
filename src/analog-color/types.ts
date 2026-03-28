export const ANALOG_COLOR_PRESETS = [
  'light',
  'standard',
  'strong',
] as const

export type AnalogColorPreset = (typeof ANALOG_COLOR_PRESETS)[number]

export interface AnalogColorSettingsValues {
  enabled: boolean
  preset: AnalogColorPreset
}
