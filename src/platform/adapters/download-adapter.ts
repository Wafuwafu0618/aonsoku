import { isDesktop } from '@/platform/capabilities'
import type { IDownloadPayload } from '@/platform/contracts/desktop-contract'

/**
 * Download Adapter
 *
 * ファイルダウンロードの抽象化
 */

export interface DownloadPayload {
  url: string
  fileId: string
  filename?: string
}

/**
 * ファイルをダウンロード（Desktop版）
 */
export function downloadFile(payload: DownloadPayload): void {
  if (!isDesktop()) return

  window.api.downloadFile({
    url: payload.url,
    fileId: payload.fileId,
  } as IDownloadPayload)
}

/**
 * ダウンロード完了リスナーを登録
 */
export function onDownloadCompleted(
  callback: (fileId: string) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.downloadCompletedListener(callback)

  // Note: preload側にリスナー解除機能がない場合
  return () => {
    // クリーンアップ処理（必要に応じて実装）
  }
}

/**
 * ダウンロード失敗リスナーを登録
 */
export function onDownloadFailed(
  callback: (fileId: string) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.downloadFailedListener(callback)

  return () => {
    // クリーンアップ処理（必要に応じて実装）
  }
}

/**
 * ブラウザ版ダウンロード（フォールバック）
 */
export function downloadViaBrowser(url: string, filename = ''): void {
  const element = document.createElement('a')
  element.setAttribute('href', url)
  element.setAttribute('target', '_blank')
  element.setAttribute('download', filename)

  element.style.display = 'none'
  document.body.appendChild(element)
  element.click()
  document.body.removeChild(element)
}
