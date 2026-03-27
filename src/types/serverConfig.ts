import { SettingsOptions } from '@/app/components/settings/options'

export enum AuthType {
  PASSWORD,
  TOKEN,
}

export interface IServerConfig {
  url: string
  username: string
  password: string
  protocolVersion?: string
  serverType?: string
  extensionsSupported?: Record<string, number[]>
}

export type PageViewType = 'grid' | 'table'
export type MediaLibraryMode = 'navidrome' | 'applemusic'

interface IAppPages {
  showInfoPanel: boolean
  toggleShowInfoPanel: () => void
  hideRadiosSection: boolean
  setHideRadiosSection: (value: boolean) => void
  artistsPageViewType: PageViewType
  setArtistsPageViewType: (type: PageViewType) => void
  imagesCacheLayerEnabled: boolean
  setImagesCacheLayerEnabled: (value: boolean) => void
  backgroundImageUrl: string | null
  backgroundImageName: string | null
  setBackgroundImage: (value: { url: string; name: string } | null) => void
  mediaLibraryMode: MediaLibraryMode
  setMediaLibraryMode: (mode: MediaLibraryMode) => void
  appleMusicFavoriteGenres: string[]
  setAppleMusicFavoriteGenres: (genres: string[]) => void
}

export interface IAppData extends IServerConfig {
  authType: AuthType | null
  isServerConfigured: boolean
  skipServerLogin: boolean
  osType: string
  logoutDialogState: boolean
  hideServer: boolean
  lockUser: boolean
  songCount: number | null
}

export interface IAppActions {
  setOsType: (value: string) => void
  setUrl: (value: string) => void
  setUsername: (value: string) => void
  setPassword: (value: string) => void
  saveConfig: (data: IServerConfig) => Promise<boolean>
  skipServerLogin: () => void
  removeConfig: () => void
  setLogoutDialogState: (value: boolean) => void
}

export interface IAppCommand {
  open: boolean
  setOpen: (value: boolean) => void
}

export interface IAppUpdate {
  openDialog: boolean
  setOpenDialog: (value: boolean) => void
  remindOnNextBoot: boolean
  setRemindOnNextBoot: (value: boolean) => void
}

interface IAppSettings {
  openDialog: boolean
  setOpenDialog: (value: boolean) => void
  currentPage: SettingsOptions
  setCurrentPage: (page: SettingsOptions) => void
}

interface IPodcasts {
  active: boolean
  setActive: (value: boolean) => void
  serviceUrl: string
  setServiceUrl: (value: string) => void
  useDefaultUser: boolean
  setUseDefaultUser: (value: boolean) => void
  customUser: string
  setCustomUser: (value: string) => void
  customUrl: string
  setCustomUrl: (value: string) => void
  collapsibleState: boolean
  setCollapsibleState: (value: boolean) => void
}

interface IAccounts {
  discord: {
    rpcEnabled: boolean
    rpcClientId: string
    setRpcEnabled: (value: boolean) => void
    setRpcClientId: (value: string) => void
  }
}

// When changing the desktop data types
// You have to update the electron one.
// Located at -> electron > main > core > settings.ts
interface IDesktop {
  data: {
    minimizeToTray: boolean
    remoteRelay: {
      enabled: boolean
      localPort: number
      cloudflaredPath: string
      tunnelArgs: string
      defaultProfile: 'alac' | 'aac'
    }
  }
  actions: {
    setMinimizeToTray: (value: boolean) => void
    setRemoteRelayEnabled: (value: boolean) => void
    setRemoteRelayLocalPort: (value: number) => void
    setRemoteRelayCloudflaredPath: (value: string) => void
    setRemoteRelayTunnelArgs: (value: string) => void
    setRemoteRelayDefaultProfile: (value: 'alac' | 'aac') => void
  }
}

export interface IAppContext {
  data: IAppData
  accounts: IAccounts
  podcasts: IPodcasts
  pages: IAppPages
  desktop: IDesktop
  command: IAppCommand
  actions: IAppActions
  update: IAppUpdate
  settings: IAppSettings
}
