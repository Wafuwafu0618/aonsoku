import { isDesktop } from '@/platform/capabilities'

/**
 * Window Adapter
 *
 * ウィンドウ制御の抽象化
 */

export interface WindowState {
  isFullscreen: boolean
  isMaximized: boolean
}

/**
 * 現在のウィンドウ状態を取得
 */
export async function getWindowState(): Promise<WindowState> {
  if (!isDesktop()) {
    return { isFullscreen: false, isMaximized: false }
  }

  const [isFullscreen, isMaximized] = await Promise.all([
    window.api.isFullScreen(),
    window.api.isMaximized(),
  ])

  return { isFullscreen, isMaximized }
}

/**
 * 全画面モードに入る
 */
export function enterFullscreen(): void {
  if (!isDesktop()) return
  window.api.enterFullScreen()
}

/**
 * 全画面モードを終了
 */
export function exitFullscreen(): void {
  if (!isDesktop()) return
  window.api.exitFullScreen()
}

/**
 * 全画面状態の変更を監視
 */
export function onFullscreenChange(
  callback: (isFullscreen: boolean) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.fullscreenStatusListener(callback)

  return () => {
    window.api.removeFullscreenStatusListener()
  }
}

/**
 * 最大化状態を切り替え
 */
export function toggleMaximize(isMaximized: boolean): void {
  if (!isDesktop()) return
  window.api.toggleMaximize(isMaximized)
}

/**
 * 最小化
 */
export function minimize(): void {
  if (!isDesktop()) return
  window.api.toggleMinimize()
}

/**
 * ウィンドウを閉じる
 */
export function close(): void {
  if (!isDesktop()) return
  window.api.closeWindow()
}

/**
 * 最大化状態の変更を監視
 */
export function onMaximizeChange(
  callback: (isMaximized: boolean) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.maximizedStatusListener(callback)

  return () => {
    window.api.removeMaximizedStatusListener()
  }
}
