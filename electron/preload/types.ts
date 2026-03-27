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
  PickBackgroundImageFile = 'pick-background-image-file',
  PickParametricEqFile = 'pick-parametric-eq-file',
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
  SpotifyConnectInitialize = 'spotify-connect-initialize',
  SpotifyConnectStartReceiver = 'spotify-connect-start-receiver',
  SpotifyConnectStatus = 'spotify-connect-status',
  SpotifyConnectListDevices = 'spotify-connect-list-devices',
  SpotifyConnectSetActiveDevice = 'spotify-connect-set-active-device',
  SpotifyConnectPlayUri = 'spotify-connect-play-uri',
  SpotifyConnectOAuthAuthorize = 'spotify-connect-oauth-authorize',
  SpotifyConnectOAuthRefresh = 'spotify-connect-oauth-refresh',
  SpotifyConnectDispose = 'spotify-connect-dispose',
  SpotifyConnectEvent = 'spotify-connect-event',
  AppleMusicResolve = 'apple-music-resolve',
  AppleMusicSetWrapperConfig = 'apple-music-set-wrapper-config',
  AppleMusicWrapperBuildImage = 'apple-music-wrapper-build-image',
  AppleMusicWrapperStartService = 'apple-music-wrapper-start-service',
  AppleMusicWrapperStopService = 'apple-music-wrapper-stop-service',
  AppleMusicWrapperStartLogin = 'apple-music-wrapper-start-login',
  AppleMusicWrapperStopLogin = 'apple-music-wrapper-stop-login',
  AppleMusicWrapperSubmitTwoFactorCode = 'apple-music-wrapper-submit-two-factor-code',
  AppleMusicWrapperGetStatus = 'apple-music-wrapper-get-status',
  AppleMusicWrapperGetLogs = 'apple-music-wrapper-get-logs',
  AppleMusicWrapperGetMusicTokenPreview = 'apple-music-wrapper-get-music-token-preview',
  AppleMusicGetLastRequestDebug = 'apple-music-get-last-request-debug',
  AppleMusicGetDebugReport = 'apple-music-get-debug-report',
  AppleMusicOpenSignInWindow = 'apple-music-open-sign-in-window',
  AppleMusicApiRequest = 'apple-music-api-request',
  RemoteRelayStateUpdate = 'remote-relay-state-update',
  RemoteRelayGetStatus = 'remote-relay-get-status',
  RemoteRelayStartTunnel = 'remote-relay-start-tunnel',
  RemoteRelayStopTunnel = 'remote-relay-stop-tunnel',
  RemoteRelayCommand = 'remote-relay-command',
  RemoteRelayLifecycle = 'remote-relay-lifecycle',
  RemoteLibraryRequest = 'remote-library-request',
  RemoteLibraryResponse = 'remote-library-response',
}

export interface LocalLibraryDirectoryEntry {
  path: string
  name: string
}

export interface ParametricEqFileEntry {
  path: string
  name: string
}

export interface BackgroundImageFileEntry {
  path: string
  name: string
  url: string
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

export type NativeAudioParametricEqFilterType = 'PK' | 'LSC' | 'HSC'

export interface NativeAudioParametricEqBand {
  enabled: boolean
  type: NativeAudioParametricEqFilterType
  frequencyHz: number
  gainDb: number
  q: number
}

export interface NativeAudioParametricEqConfig {
  preampDb: number
  bands: NativeAudioParametricEqBand[]
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
  parametricEq?: NativeAudioParametricEqConfig
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
  | 'relayPcmFormat'
  | 'relayPcmChunk'

export interface NativeAudioEvent {
  type: NativeAudioEventType
  currentTimeSeconds?: number
  durationSeconds?: number
  error?: NativeAudioErrorPayload
  sampleRateHz?: number
  channels?: number
  sampleFormat?: 's16le'
  pcmBase64?: string
}

export interface SpotifyConnectInitializeRequest {
  deviceName?: string
  cacheDir?: string
  zeroconfPort?: number
  librespotPath?: string
  accessToken?: string
}

export interface SpotifyConnectErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface SpotifyConnectCommandResult {
  ok: boolean
  error?: SpotifyConnectErrorPayload
}

export interface SpotifyConnectInitializeResult {
  ok: boolean
  version: string
  engine: string
  message?: string
  receiverRunning: boolean
}

export interface SpotifyConnectTrackInfo {
  spotifyUri: string
  title?: string
  artists?: string[]
  album?: string
  coverArtUrl?: string
  durationSeconds?: number
}

export interface SpotifyConnectDeviceInfo {
  id: string
  name: string
  type?: string
  isActive?: boolean
  isRestricted?: boolean
  volumePercent?: number
  isPrivateSession?: boolean
  supportsVolume?: boolean
}

export interface SpotifyConnectSetActiveDeviceRequest {
  deviceId: string
  transferPlayback?: boolean
}

export interface SpotifyConnectPlayUriRequest {
  spotifyUri: string
  startAtSeconds?: number
  deviceId?: string
}

export interface SpotifyConnectOAuthAuthorizeRequest {
  clientId: string
  redirectPort?: number
  scopes?: string[]
}

export interface SpotifyConnectOAuthRefreshRequest {
  clientId: string
  refreshToken: string
}

export interface SpotifyConnectOAuthTokenResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
  tokenType?: string
  obtainedAtEpochMs?: number
  error?: SpotifyConnectErrorPayload
}

export interface SpotifyConnectListDevicesResult {
  ok: boolean
  devices: SpotifyConnectDeviceInfo[]
  activeDeviceId?: string
  error?: SpotifyConnectErrorPayload
}

export interface SpotifyConnectStatusResult {
  ok: boolean
  initialized: boolean
  receiverRunning: boolean
  sessionConnected: boolean
  isPlaying: boolean
  currentTimeSeconds: number
  durationSeconds: number
  volume: number
  activeDeviceId?: string
  activeTrack?: SpotifyConnectTrackInfo
  error?: SpotifyConnectErrorPayload
}

export type SpotifyConnectEventType =
  | 'ready'
  | 'receiverStarted'
  | 'receiverStopped'
  | 'sessionConnected'
  | 'sessionDisconnected'
  | 'deviceListChanged'
  | 'trackChanged'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'ended'
  | 'error'

export interface SpotifyConnectEvent {
  type: SpotifyConnectEventType
  receiverRunning?: boolean
  sessionConnected?: boolean
  isPlaying?: boolean
  currentTimeSeconds?: number
  durationSeconds?: number
  volume?: number
  activeTrack?: SpotifyConnectTrackInfo
  message?: string
  error?: SpotifyConnectErrorPayload
}

export interface AppleMusicResolveResult {
  ok: boolean
  tempFilePath?: string
  durationSeconds?: number
  error?: { code: string; message: string }
}

export interface AppleMusicWrapperConfig {
  host: string
  decryptPort: number
  m3u8Port: number
  accountPort: number
}

export interface AppleMusicWrapperCommandResult {
  ok: boolean
  message: string
  stderr?: string
}

export interface AppleMusicWrapperContainerState {
  state: 'missing' | 'running' | 'stopped'
  statusText: string
}

export interface AppleMusicWrapperRuntimeStatus {
  dockerAvailable: boolean
  wrapperDirPath: string | null
  dataDirPath: string | null
  musicTokenPath: string | null
  imageExists: boolean
  service: AppleMusicWrapperContainerState
  login: AppleMusicWrapperContainerState
  accountReachable: boolean
  hasMusicToken: boolean
}

export interface AppleMusicWrapperLogsResult {
  ok: boolean
  message: string
  logs: string
}

export interface AppleMusicWrapperStartLoginRequest {
  username: string
  password: string
}

export interface AppleMusicRequestDebug {
  requestId: number
  url: string
  method: string
  statusCode?: number
  timestampMs: number
  headers: Record<string, string>
}

export type AppleMusicApiAction =
  | 'status'
  | 'search'
  | 'catalog-album'
  | 'catalog-playlist'
  | 'library'
  | 'browse'

export type AppleMusicBrowseKind = 'new-releases' | 'top-charts'

export interface AppleMusicApiRequestPayload {
  action: AppleMusicApiAction
  query?: string
  types?: string[]
  id?: string
  limit?: number
  offset?: number
  browseKind?: AppleMusicBrowseKind
}

export interface AppleMusicApiResponse {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export interface AppleMusicOpenSignInResult {
  ok: boolean
  error?: { code: string; message: string }
}

export type RemoteRelayStreamProfile = 'alac' | 'aac'

export type RemoteRelayMediaSource = 'navidrome' | 'local' | 'unsupported'

export type RemotePlaybackTarget = 'desktop' | 'mobile'

export interface RemotePlaybackDevice {
  id: RemotePlaybackTarget
  name: string
  description?: string
  selected: boolean
}

export interface RemoteRelayNowPlaying {
  id?: string
  title?: string
  artist?: string
  album?: string
  coverArtId?: string
}

export interface RemoteRelayStateUpdatePayload {
  mediaType: 'song' | 'radio' | 'podcast'
  source: RemoteRelayMediaSource
  src?: string
  sourceCodec?: string
  sourceSampleRateHz?: number
  targetSampleRateHz?: number
  oversamplingFilterId?: string
  signalPath?: string
  isPlaying: boolean
  currentTimeSeconds: number
  durationSeconds: number
  volume: number
  hasPrev: boolean
  hasNext: boolean
  nowPlaying?: RemoteRelayNowPlaying
}

export type RemoteRelayCommandType =
  | 'playPause'
  | 'prev'
  | 'next'
  | 'seek'
  | 'setVolume'
  | 'playAlbum'
  | 'playSong'
  | 'setPlaybackTarget'

export interface RemoteRelayCommandPayload {
  command: RemoteRelayCommandType
  value?: number
  albumId?: string
  songId?: string
  target?: RemotePlaybackTarget
}

export interface RemoteRelayLifecycleEvent {
  remoteSessionActive: boolean
  reason?: string
}

export interface RemoteRelayTunnelCommandResult {
  ok: boolean
  message: string
}

export interface RemoteRelayStatus {
  enabled: boolean
  localPort: number
  localUrl: string
  tunnelRunning: boolean
  tunnelStatus: 'stopped' | 'starting' | 'running' | 'error'
  tunnelMessage: string
  remoteSessionActive: boolean
  defaultProfile: RemoteRelayStreamProfile
  streamProfile: RemoteRelayStreamProfile
  cloudflaredPath: string
  tunnelArgs: string
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
  pickBackgroundImageFile: () => Promise<BackgroundImageFileEntry | null>
  pickParametricEqFile: () => Promise<ParametricEqFileEntry | null>
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
  nativeAudioSeek: (
    positionSeconds: number,
  ) => Promise<NativeAudioCommandResult>
  nativeAudioSetVolume: (volume: number) => Promise<NativeAudioCommandResult>
  nativeAudioSetLoop: (loop: boolean) => Promise<NativeAudioCommandResult>
  nativeAudioSetPlaybackRate: (
    playbackRate: number,
  ) => Promise<NativeAudioCommandResult>
  nativeAudioDispose: () => Promise<NativeAudioCommandResult>
  nativeAudioEventListener: (func: (event: NativeAudioEvent) => void) => void
  removeNativeAudioEventListener: () => void
  spotifyConnectInitialize: (
    payload?: SpotifyConnectInitializeRequest,
  ) => Promise<SpotifyConnectInitializeResult>
  spotifyConnectStartReceiver: () => Promise<SpotifyConnectCommandResult>
  spotifyConnectStatus: () => Promise<SpotifyConnectStatusResult>
  spotifyConnectListDevices: () => Promise<SpotifyConnectListDevicesResult>
  spotifyConnectSetActiveDevice: (
    payload: SpotifyConnectSetActiveDeviceRequest,
  ) => Promise<SpotifyConnectCommandResult>
  spotifyConnectPlayUri: (
    payload: SpotifyConnectPlayUriRequest,
  ) => Promise<SpotifyConnectCommandResult>
  spotifyConnectOAuthAuthorize: (
    payload: SpotifyConnectOAuthAuthorizeRequest,
  ) => Promise<SpotifyConnectOAuthTokenResult>
  spotifyConnectOAuthRefresh: (
    payload: SpotifyConnectOAuthRefreshRequest,
  ) => Promise<SpotifyConnectOAuthTokenResult>
  spotifyConnectDispose: () => Promise<SpotifyConnectCommandResult>
  spotifyConnectEventListener: (
    func: (event: SpotifyConnectEvent) => void,
  ) => void
  removeSpotifyConnectEventListener: () => void
  appleMusicResolve: (adamId: string) => Promise<AppleMusicResolveResult>
  appleMusicSetWrapperConfig: (config: AppleMusicWrapperConfig) => Promise<void>
  appleMusicWrapperBuildImage: () => Promise<AppleMusicWrapperCommandResult>
  appleMusicWrapperStartService: () => Promise<AppleMusicWrapperCommandResult>
  appleMusicWrapperStopService: () => Promise<AppleMusicWrapperCommandResult>
  appleMusicWrapperStartLogin: (
    payload: AppleMusicWrapperStartLoginRequest,
  ) => Promise<AppleMusicWrapperCommandResult>
  appleMusicWrapperStopLogin: () => Promise<AppleMusicWrapperCommandResult>
  appleMusicWrapperSubmitTwoFactorCode: (
    code: string,
  ) => Promise<AppleMusicWrapperCommandResult>
  appleMusicWrapperGetStatus: () => Promise<AppleMusicWrapperRuntimeStatus>
  appleMusicWrapperGetLogs: (
    target?: 'service' | 'login',
  ) => Promise<AppleMusicWrapperLogsResult>
  appleMusicWrapperGetMusicTokenPreview: () => Promise<string>
  appleMusicGetLastRequestDebug: () => Promise<AppleMusicRequestDebug | null>
  appleMusicGetDebugReport: () => Promise<string>
  appleMusicOpenSignInWindow: () => Promise<AppleMusicOpenSignInResult>
  appleMusicApiRequest: (
    payload: AppleMusicApiRequestPayload,
  ) => Promise<AppleMusicApiResponse>
  remoteRelayUpdateState: (payload: RemoteRelayStateUpdatePayload) => void
  remoteRelayGetStatus: () => Promise<RemoteRelayStatus>
  remoteRelayStartTunnel: () => Promise<RemoteRelayTunnelCommandResult>
  remoteRelayStopTunnel: () => Promise<RemoteRelayTunnelCommandResult>
  remoteRelayCommandListener: (
    func: (payload: RemoteRelayCommandPayload) => void,
  ) => void
  removeRemoteRelayCommandListener: () => void
  remoteRelayLifecycleListener: (
    func: (payload: RemoteRelayLifecycleEvent) => void,
  ) => void
  removeRemoteRelayLifecycleListener: () => void
  remoteLibraryRequestListener: (
    func: (request: RemoteLibraryRequest) => void,
  ) => void
  removeRemoteLibraryRequestListener: () => void
  sendRemoteLibraryResponse: (response: RemoteLibraryResponse) => void
}

export interface RemoteLibraryRequest {
  requestId: string
  channel: string
  data: unknown
}

export interface RemoteLibraryResponse {
  requestId: string
  data: unknown
}
