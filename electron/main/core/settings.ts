import { AonsokuStore } from './store'

export type RemoteRelayStreamProfile = 'alac' | 'aac'

export type RemoteRelayTunnelStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface RemoteRelayLastStatus {
  tunnelStatus: RemoteRelayTunnelStatus
  message: string
  updatedAtMs: number
}

export interface RemoteRelaySettings {
  enabled: boolean
  localPort: number
  cloudflaredPath: string
  tunnelArgs: string
  defaultProfile: RemoteRelayStreamProfile
  lastStatus: RemoteRelayLastStatus
}

type RemoteRelaySettingsPayload = Omit<RemoteRelaySettings, 'lastStatus'> & {
  lastStatus?: RemoteRelayLastStatus
}

export interface ISettingPayload {
  minimizeToTray: boolean
  remoteRelay: RemoteRelaySettingsPayload
}

const DEFAULT_REMOTE_RELAY_LAST_STATUS: RemoteRelayLastStatus = {
  tunnelStatus: 'stopped',
  message: 'Remote relay is disabled.',
  updatedAtMs: Date.now(),
}

const DEFAULT_REMOTE_RELAY_SETTINGS: RemoteRelaySettings = {
  enabled: false,
  localPort: 39096,
  cloudflaredPath: '',
  tunnelArgs: '',
  defaultProfile: 'alac',
  lastStatus: DEFAULT_REMOTE_RELAY_LAST_STATUS,
}

function normalizeRemoteRelaySettings(
  value: RemoteRelaySettingsPayload | undefined,
): RemoteRelaySettings {
  if (!value) {
    return { ...DEFAULT_REMOTE_RELAY_SETTINGS }
  }

  return {
    enabled: value.enabled ?? DEFAULT_REMOTE_RELAY_SETTINGS.enabled,
    localPort: value.localPort ?? DEFAULT_REMOTE_RELAY_SETTINGS.localPort,
    cloudflaredPath:
      value.cloudflaredPath ?? DEFAULT_REMOTE_RELAY_SETTINGS.cloudflaredPath,
    tunnelArgs: value.tunnelArgs ?? DEFAULT_REMOTE_RELAY_SETTINGS.tunnelArgs,
    defaultProfile:
      value.defaultProfile ?? DEFAULT_REMOTE_RELAY_SETTINGS.defaultProfile,
    lastStatus: value.lastStatus ?? DEFAULT_REMOTE_RELAY_SETTINGS.lastStatus,
  }
}

const settingsStore = new AonsokuStore<ISettingPayload>({
  name: 'settings',
  defaults: {
    minimizeToTray: false,
    remoteRelay: DEFAULT_REMOTE_RELAY_SETTINGS,
  },
})

export function saveAppSettings(payload: ISettingPayload) {
  try {
    const currentRemoteRelay = normalizeRemoteRelaySettings(
      settingsStore.get('remoteRelay'),
    )
    const nextRemoteRelay: RemoteRelaySettings = {
      ...currentRemoteRelay,
      ...payload.remoteRelay,
      lastStatus: payload.remoteRelay.lastStatus ?? currentRemoteRelay.lastStatus,
    }

    settingsStore.set({
      minimizeToTray: payload.minimizeToTray,
      remoteRelay: nextRemoteRelay,
    })
  } catch (error) {
    console.log('Unable to save app settings to store.', error)
  }
}

export function getAppSetting<T extends keyof ISettingPayload>(
  item: T,
): ISettingPayload[T] {
  return settingsStore.get(item)
}

export function getRemoteRelaySettings(): RemoteRelaySettings {
  return normalizeRemoteRelaySettings(settingsStore.get('remoteRelay'))
}

export function saveRemoteRelayLastStatus(
  status: RemoteRelayLastStatus,
): RemoteRelaySettings {
  const current = normalizeRemoteRelaySettings(settingsStore.get('remoteRelay'))
  const next: RemoteRelaySettings = {
    ...current,
    lastStatus: status,
  }
  settingsStore.set('remoteRelay', next)
  return next
}
