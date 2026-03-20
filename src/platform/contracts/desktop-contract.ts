/**
 * Desktop API Contracts
 *
 * Electron固有のAPI型定義を集約
 * 元: electron/preload/types.ts
 */

// electron-updaterの型を再エクスポート
export type {
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater'
// Discord RPC関連の型
export type { RpcPayload } from '../../../electron/main/core/discordRpc'
// ダウンロード関連の型
export type { IDownloadPayload } from '../../../electron/main/core/downloads'
// 設定関連の型
export type { ISettingPayload } from '../../../electron/main/core/settings'
// Preloadからの型を再エクスポート
export {
  type IAonsokuAPI,
  IpcChannels,
  type NativeAudioCommandResult,
  type NativeAudioDeviceInfo,
  type NativeAudioErrorPayload,
  type NativeAudioEvent,
  type NativeAudioEventType,
  type NativeAudioInitializeResult,
  type NativeAudioLoadRequest,
  type NativeAudioOutputMode,
  type NativeAudioParametricEqBand,
  type NativeAudioParametricEqConfig,
  type NativeAudioParametricEqFilterType,
  type LocalLibraryDirectoryEntry,
  type ParametricEqFileEntry,
  type LocalLibraryFileContent,
  type LocalLibraryFileEntry,
  type OverlayColors,
  type PlayerStateListenerActions,
  type PlayerStatePayload,
} from '../../../electron/preload/types'

/**
 * Desktop機能の可用性情報
 */
export interface DesktopCapabilities {
  isDesktop: boolean
  isWindows: boolean
  isMacOS: boolean
  isLinux: boolean
  hasWindowControl: boolean
  hasMediaKeys: boolean
  hasDiscordRpc: boolean
  hasAutoUpdater: boolean
  hasNativeTheme: boolean
  hasDownloadSupport: boolean
}

/**
 * Player状態更新ペイロード
 */
export interface PlayerStateUpdate {
  isPlaying: boolean
  hasPrevious: boolean
  hasNext: boolean
  hasSonglist: boolean
}

/**
 * Playerアクション
 */
export type PlayerAction =
  | 'togglePlayPause'
  | 'skipBackwards'
  | 'skipForward'
  | 'toggleShuffle'
  | 'toggleRepeat'

/**
 * ウィンドウ状態
 */
export interface WindowState {
  isFullScreen: boolean
  isMaximized: boolean
}

/**
 * ダウンロードペイロード
 */
export interface DownloadPayload {
  url: string
  filename: string
  fileId: string
}

/**
 * テーマカラー設定
 */
export interface ThemeColors {
  color: string
  symbol: string
  bgColor: string
}
