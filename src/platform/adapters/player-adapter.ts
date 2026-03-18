import { isDesktop } from '@/platform/capabilities'
import {
  PlayerAction,
  PlayerStateUpdate,
} from '@/platform/contracts/desktop-contract'

/**
 * Player Adapter
 *
 * メディアキー制御・プレイヤー状態同期の抽象化
 */

/**
 * プレイヤー状態を更新（タスクバー/メディアセッション用）
 */
export function updatePlayerState(payload: PlayerStateUpdate): void {
  if (!isDesktop()) return

  window.api.updatePlayerState({
    isPlaying: payload.isPlaying,
    hasPrevious: payload.hasPrevious,
    hasNext: payload.hasNext,
    hasSonglist: payload.hasSonglist,
  })
}

/**
 * プレイヤーアクションリスナーを登録（メディアキー用）
 */
export function onPlayerAction(
  callback: (action: PlayerAction) => void,
): () => void {
  if (!isDesktop()) {
    // Desktop環境でない場合はダミーのクリーンアップ関数を返す
    return () => {}
  }

  window.api.playerStateListener((action) => {
    callback(action as PlayerAction)
  })

  // クリーンアップ関数
  return () => {
    // Note: preload側にリスナー解除機能がない場合は何もしない
    // 必要に応じてwindow.api.removePlayerStateListener()等を実装
  }
}

/**
 * Play/Pauseをトグル
 */
export function togglePlayPause(): void {
  // 内部処理は不要（メディアキーイベントを受け取る側）
  // 必要に応じて外部にイベント発行
}

/**
 * 前の曲へスキップ
 */
export function skipBackwards(): void {
  // 内部処理は不要（メディアキーイベントを受け取る側）
}

/**
 * 次の曲へスキップ
 */
export function skipForward(): void {
  // 内部処理は不要（メディアキーイベントを受け取る側）
}
