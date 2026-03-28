export const CROSSFEED_PRESETS = ['low', 'medium', 'high'] as const

export type CrossfeedPreset = (typeof CROSSFEED_PRESETS)[number]

export interface CrossfeedSettingsValues {
  enabled: boolean
  preset: CrossfeedPreset
}
