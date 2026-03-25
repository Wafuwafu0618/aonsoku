/**
 * Platform Adapters Index
 *
 * Desktop APIのアダプターを集約して公開
 */

// Discord Adapter
export {
  clearDiscordActivity,
  discordRpc,
  isDiscordRpcEnabled,
  sendCurrentSongToDiscord,
} from './adapters/discord-adapter'
// Download Adapter
export {
  downloadFile,
  downloadViaBrowser,
  onDownloadCompleted,
  onDownloadFailed,
} from './adapters/download-adapter'
// Local Library Adapter
export {
  listLocalLibraryFiles,
  pickLocalLibraryDirectory,
  readLocalLibraryFile,
} from './adapters/local-library-adapter'
export { pickBackgroundImageFile } from './adapters/background-image-adapter'
export { pickParametricEqFile } from './adapters/parametric-eq-adapter'
export {
  onSpotifyConnectEvent,
  spotifyConnectListDevices,
  spotifyConnectOAuthAuthorize,
  spotifyConnectOAuthRefresh,
  spotifyConnectPlayUri,
  spotifyConnectDispose,
  spotifyConnectInitialize,
  spotifyConnectSetActiveDevice,
  spotifyConnectStartReceiver,
  spotifyConnectStatus,
} from './adapters/spotify-connect-adapter'

// Player Adapter
export {
  onPlayerAction,
  skipBackwards,
  skipForward,
  togglePlayPause,
  updatePlayerState,
} from './adapters/player-adapter'
// Settings Adapter
export { saveAppSettings } from './adapters/settings-adapter'
// Theme Adapter
export {
  getValidThemeFromEnv,
  setDesktopTitleBarColors,
  setNativeTheme,
  setTitleBarColors,
} from './adapters/theme-adapter'
// Update Adapter
export {
  checkForUpdates,
  downloadUpdate,
  onDownloadProgress,
  onUpdateAvailable,
  onUpdateDownloaded,
  onUpdateError,
  onUpdateNotAvailable,
  quitAndInstall,
} from './adapters/update-adapter'
// Window Adapter
export {
  close,
  enterFullscreen,
  exitFullscreen,
  getWindowState,
  minimize,
  onFullscreenChange,
  onMaximizeChange,
  toggleMaximize,
} from './adapters/window-adapter'
// Capabilities（機能チェック）
export {
  capabilities,
  isDesktop,
  isDeviceLinux,
  isDeviceMacOS,
  isDeviceWindows,
  isLinux,
  isMacOS,
  isWindows,
} from './capabilities'
// Contracts（型定義）
export type {
  DesktopCapabilities,
  DownloadPayload,
  PlayerAction,
  PlayerStateUpdate,
  ThemeColors,
  WindowState,
} from './contracts/desktop-contract'
