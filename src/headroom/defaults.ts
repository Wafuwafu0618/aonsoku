import { HeadroomSettingsValues } from './types'

export const DEFAULT_HEADROOM_SETTINGS: HeadroomSettingsValues = {
  headroomDb: 0,
}

export const createDefaultHeadroomSettings = (): HeadroomSettingsValues => ({
  ...DEFAULT_HEADROOM_SETTINGS,
})

