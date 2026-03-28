import { CrossfeedSettingsValues } from './types'

export const DEFAULT_CROSSFEED_SETTINGS: CrossfeedSettingsValues = {
  enabled: false,
  preset: 'medium',
}

export const createDefaultCrossfeedSettings = (): CrossfeedSettingsValues => ({
  ...DEFAULT_CROSSFEED_SETTINGS,
})
