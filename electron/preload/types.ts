import {
  type ProgressInfo,
  type UpdateCheckResult,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from 'electron-updater'
import { RpcPayload } from '../main/core/discordRpc'
import { IDownloadPayload } from '../main/core/downloads'
import { ISettingPayload } from '../main/core/settings'

export enum IpcChannels {
  FullscreenStatus = 'fullscreen-status',
  ToggleFullscreen = 'toggle-fullscreen',
  IsFullScreen = 'is-fullscreen',
  IsMaximized = 'is-maximized',
  MaximizedStatus = 'maximized-status',
  ToggleMaximize = 'toggle-maximize',
  ToggleMinimize = 'toggle-minimize',
  CloseWindow = 'close-window',
  ThemeChanged = 'theme-changed',
  UpdateNativeTheme = 'update-native-theme',
  HandleDownloads = 'handle-downloads',
  DownloadCompleted = 'download-completed',
  DownloadFailed = 'download-failed',
  UpdatePlayerState = 'update-player-state',
  PlayerStateListener = 'player-state-listener',
  SetDiscordRpcActivity = 'set-discord-rpc-activity',
  ClearDiscordRpcActivity = 'clear-discord-rpc-activity',
  SaveAppSettings = 'save-app-settings',
  CheckForUpdates = 'check-for-updates',
  DownloadUpdate = 'download-update',
  QuitAndInstall = 'quit-and-install',
  UpdateAvailable = 'update-available',
  UpdateNotAvailable = 'update-not-available',
  UpdateError = 'update-error',
  DownloadProgress = 'download-progress',
  UpdateDownloaded = 'update-downloaded',
  PickLocalLibraryDirectory = 'pick-local-library-directory',
  ListLocalLibraryFiles = 'list-local-library-files',
  ReadLocalLibraryFile = 'read-local-library-file',
  NativeAudioInitialize = 'native-audio-initialize',
  NativeAudioListDevices = 'native-audio-list-devices',
  NativeAudioSetOutputMode = 'native-audio-set-output-mode',
  NativeAudioLoad = 'native-audio-load',
  NativeAudioPlay = 'native-audio-play',
  NativeAudioPause = 'native-audio-pause',
  NativeAudioSeek = 'native-audio-seek',
  NativeAudioSetVolume = 'native-audio-set-volume',
  NativeAudioSetLoop = 'native-audio-set-loop',
  NativeAudioSetPlaybackRate = 'native-audio-set-playback-rate',
  NativeAudioDispose = 'native-audio-dispose',
  NativeAudioEvent = 'native-audio-event',
}

export interface LocalLibraryDirectoryEntry {
  path: string
  name: string
}

export interface LocalLibraryFileEntry {
  path: string
  name: string
  size: number
  modifiedAt: number
  createdAt: number
}

export interface LocalLibraryFileContent {
  path: string
  data: ArrayBuffer
  size: number
  modifiedAt: number
  createdAt: number
}

export type OverlayColors = {
  color: string
  symbol: string
  bgColor: string
}

export type PlayerStatePayload = {
  isPlaying: boolean
  hasPrevious: boolean
  hasNext: boolean
  hasSonglist: boolean
}

export type PlayerStateListenerActions =
  | 'togglePlayPause'
  | 'skipBackwards'
  | 'skipForward'
  | 'toggleShuffle'
  | 'toggleRepeat'

export type NativeAudioOutputMode =
  | 'wasapi-shared'
  | 'wasapi-exclusive'
  | 'asio'

export interface NativeAudioInitializeResult {
  ok: boolean
  version: string
  engine: string
  message?: string
}

export interface NativeAudioDeviceInfo {
  id: string
  name: string
  mode: NativeAudioOutputMode
  isDefault: boolean
}

export interface NativeAudioLoadRequest {
  src: string
  autoplay?: boolean
  loop?: boolean
  startAtSeconds?: number
  playbackRate?: number
  durationSeconds?: number
  targetSampleRateHz?: number
  oversamplingFilterId?: string
}

export interface NativeAudioErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface NativeAudioCommandResult {
  ok: boolean
  error?: NativeAudioErrorPayload
}

export type NativeAudioEventType =
  | 'ready'
  | 'loadedmetadata'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'ended'
  | 'error'
  | 'deviceChanged'

export interface NativeAudioEvent {
  type: NativeAudioEventType
  currentTimeSeconds?: number
  durationSeconds?: number
  error?: NativeAudioErrorPayload
}

export interface IAonsokuAPI {
  enterFullScreen: () => void
  exitFullScreen: () => void
  isFullScreen: () => Promise<boolean>
  fullscreenStatusListener: (func: (status: boolean) => void) => void
  removeFullscreenStatusListener: () => void
  isMaximized: () => Promise<boolean>
  maximizedStatusListener: (func: (status: boolean) => void) => void
  removeMaximizedStatusListener: () => void
  toggleMaximize: (isMaximized: boolean) => void
  toggleMinimize: () => void
  closeWindow: () => void
  setTitleBarOverlayColors: (colors: OverlayColors) => void
  setNativeTheme: (isDark: boolean) => void
  downloadFile: (payload: IDownloadPayload) => void
  downloadCompletedListener: (func: (fileId: string) => void) => void
  downloadFailedListener: (func: (fileId: string) => void) => void
  updatePlayerState: (payload: PlayerStatePayload) => void
  playerStateListener: (
    func: (action: PlayerStateListenerActions) => void,
  ) => void
  setDiscordRpcActivity: (payload: RpcPayload) => void
  clearDiscordRpcActivity: () => void
  saveAppSettings: (payload: ISettingPayload) => void
  checkForUpdates: () => Promise<UpdateCheckResult | null>
  downloadUpdate: () => void
  quitAndInstall: () => void
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void
  onUpdateNotAvailable: (callback: () => void) => void
  onUpdateError: (callback: (error: string) => void) => void
  onDownloadProgress: (callback: (progress: ProgressInfo) => void) => void
  onUpdateDownloaded: (callback: (info: UpdateDownloadedEvent) => void) => void
  pickLocalLibraryDirectory: () => Promise<LocalLibraryDirectoryEntry | null>
  listLocalLibraryFiles: (
    directories: string[],
  ) => Promise<LocalLibraryFileEntry[]>
  readLocalLibraryFile: (path: string) => Promise<LocalLibraryFileContent>
  nativeAudioInitialize: () => Promise<NativeAudioInitializeResult>
  nativeAudioListDevices: () => Promise<NativeAudioDeviceInfo[]>
  nativeAudioSetOutputMode: (
    mode: NativeAudioOutputMode,
  ) => Promise<NativeAudioCommandResult>
  nativeAudioLoad: (
    payload: NativeAudioLoadRequest,
  ) => Promise<NativeAudioCommandResult>
  nativeAudioPlay: () => Promise<NativeAudioCommandResult>
  nativeAudioPause: () => Promise<NativeAudioCommandResult>
  nativeAudioSeek: (positionSeconds: number) => Promise<NativeAudioCommandResult>
  nativeAudioSetVolume: (volume: number) => Promise<NativeAudioCommandResult>
  nativeAudioSetLoop: (loop: boolean) => Promise<NativeAudioCommandResult>
  nativeAudioSetPlaybackRate: (
    playbackRate: number,
  ) => Promise<NativeAudioCommandResult>
  nativeAudioDispose: () => Promise<NativeAudioCommandResult>
  nativeAudioEventListener: (func: (event: NativeAudioEvent) => void) => void
  removeNativeAudioEventListener: () => void
}
