import { isDesktop } from '@/platform/capabilities'
import { useAppStore } from '@/store/app.store'
import { usePlayerStore } from '@/store/player.store'

/**
 * Discord Adapter
 *
 * Discord Rich Presenceの抽象化
 */

interface DiscordActivityPayload {
  trackName: string
  albumName: string
  artist: string
  startTime: number
  endTime: number
  duration: number
}

/**
 * Discord Rich Presenceを更新
 */
function send(payload: DiscordActivityPayload): void {
  if (!isDesktop()) return

  const { rpcEnabled } = useAppStore.getState().accounts.discord
  if (!rpcEnabled) return

  window.api.setDiscordRpcActivity(payload)
}

/**
 * Discord Rich Presenceをクリア
 */
export function clearDiscordActivity(): void {
  if (!isDesktop()) return

  window.api.clearDiscordRpcActivity()
}

/**
 * 現在の曲情報をDiscordに送信
 */
export function sendCurrentSongToDiscord(): void {
  if (!isDesktop()) return

  const { playerState, songlist, actions } = usePlayerStore.getState()

  const { mediaType } = playerState
  if (mediaType !== 'song') return

  const { currentSong } = songlist
  const currentTime = actions.getCurrentProgress()
  const { isPlaying, currentDuration } = playerState

  // 停止中または曲がない場合はクリア
  if (!currentSong || !isPlaying) {
    clearDiscordActivity()
    return
  }

  // アーティスト名を整形
  const artist = currentSong.artists
    ? currentSong.artists.map((a) => a.name).join(', ')
    : currentSong.artist

  const currentTimeInMs = currentTime * 1000
  const durationInMs = currentDuration * 1000

  const startTime = Math.floor(Date.now() - currentTimeInMs)
  const endTime = Math.floor(Date.now() - currentTimeInMs + durationInMs)

  send({
    trackName: currentSong.title,
    albumName: currentSong.album,
    artist,
    startTime,
    endTime,
    duration: currentDuration,
  })
}

/**
 * Discord RPCが有効かどうか
 */
export function isDiscordRpcEnabled(): boolean {
  if (!isDesktop()) return false

  return useAppStore.getState().accounts.discord.rpcEnabled
}

// 後方互換性のためのエクスポート
export const discordRpc = {
  send: sendCurrentSongToDiscord,
  clear: clearDiscordActivity,
  sendCurrentSong: sendCurrentSongToDiscord,
}
