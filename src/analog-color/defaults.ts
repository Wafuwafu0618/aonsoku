import { AnalogColorSettingsValues } from './types'

export const DEFAULT_ANALOG_COLOR_SETTINGS: AnalogColorSettingsValues = {
  enabled: false,
  preset: 'standard',
}

export const createDefaultAnalogColorSettings = (): AnalogColorSettingsValues => ({
  ...DEFAULT_ANALOG_COLOR_SETTINGS,
})
