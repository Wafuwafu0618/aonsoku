import { isDesktop } from '@/platform/capabilities'
import type {
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from '@/platform/contracts/desktop-contract'

/**
 * Update Adapter
 *
 * アプリアップデートの抽象化
 */

/**
 * アップデートをチェック
 */
export async function checkForUpdates(): Promise<UpdateCheckResult | null> {
  if (!isDesktop()) return null

  return window.api.checkForUpdates()
}

/**
 * アップデートをダウンロード
 */
export function downloadUpdate(): void {
  if (!isDesktop()) return

  window.api.downloadUpdate()
}

/**
 * アプリを終了してインストール
 */
export function quitAndInstall(): void {
  if (!isDesktop()) return

  window.api.quitAndInstall()
}

/**
 * アップデート利用可能リスナー
 */
export function onUpdateAvailable(
  callback: (info: UpdateInfo) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.onUpdateAvailable(callback)

  return () => {
    // クリーンアップ（必要に応じて）
  }
}

/**
 * アップデートなしリスナー
 */
export function onUpdateNotAvailable(callback: () => void): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.onUpdateNotAvailable(callback)

  return () => {
    // クリーンアップ（必要に応じて）
  }
}

/**
 * アップデートエラーリスナー
 */
export function onUpdateError(callback: (error: string) => void): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.onUpdateError(callback)

  return () => {
    // クリーンアップ（必要に応じて）
  }
}

/**
 * ダウンロード進捗リスナー
 */
export function onDownloadProgress(
  callback: (progress: ProgressInfo) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.onDownloadProgress(callback)

  return () => {
    // クリーンアップ（必要に応じて）
  }
}

/**
 * アップデートダウンロード完了リスナー
 */
export function onUpdateDownloaded(
  callback: (info: UpdateDownloadedEvent) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.onUpdateDownloaded(callback)

  return () => {
    // クリーンアップ（必要に応じて）
  }
}
