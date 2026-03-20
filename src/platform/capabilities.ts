import { isElectron, osName } from 'react-device-detect'

/**
 * Desktop capabilities detection
 *
 * Electron環境での機能可用性を判定
 */

function isCypress(): boolean {
  return (window as { Cypress?: unknown }).Cypress !== undefined
}

/**
 * デスクトップ（Electron）環境かどうか
 */
export function isDesktop(): boolean {
  return isElectron && !isCypress()
}

/**
 * OS判定（デスクトップ環境のみ）
 */
const deviceLinux = osName === 'Linux'
const deviceMacOS = osName === 'Mac OS'
const deviceWindows = osName === 'Windows'

export const isLinux = isDesktop() ? deviceLinux : false
export const isMacOS = isDesktop() ? deviceMacOS : false
export const isWindows = isDesktop() ? deviceWindows : false

/**
 * 機能可用性チェック
 */
export const capabilities = {
  /**
   * ウィンドウ制御機能が使用可能か
   */
  get hasWindowControl(): boolean {
    return isDesktop()
  },

  /**
   * メディアキー制御が使用可能か
   */
  get hasMediaKeys(): boolean {
    return isDesktop()
  },

  /**
   * Discord Rich Presenceが使用可能か
   */
  get hasDiscordRpc(): boolean {
    return isDesktop()
  },

  /**
   * 自動アップデート機能が使用可能か
   */
  get hasAutoUpdater(): boolean {
    return isDesktop()
  },

  /**
   * ネイティブテーマ制御が使用可能か
   */
  get hasNativeTheme(): boolean {
    return isDesktop()
  },

  /**
   * ファイルダウンロード機能が使用可能か
   */
  get hasDownloadSupport(): boolean {
    return isDesktop()
  },

  /**
   * 設定永続化機能が使用可能か
   */
  get hasSettingsPersistence(): boolean {
    return isDesktop()
  },

  /**
   * 全てのDesktop機能をオブジェクトとして取得
   */
  get all() {
    return {
      isDesktop: isDesktop(),
      isWindows,
      isMacOS,
      isLinux,
      hasWindowControl: this.hasWindowControl,
      hasMediaKeys: this.hasMediaKeys,
      hasDiscordRpc: this.hasDiscordRpc,
      hasAutoUpdater: this.hasAutoUpdater,
      hasNativeTheme: this.hasNativeTheme,
      hasDownloadSupport: this.hasDownloadSupport,
      hasSettingsPersistence: this.hasSettingsPersistence,
    }
  },
}

// 後方互換性のため、デバイス判定もエクスポート
export {
  deviceLinux as isDeviceLinux,
  deviceMacOS as isDeviceMacOS,
  deviceWindows as isDeviceWindows,
}
