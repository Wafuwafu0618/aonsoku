import { useAppStore } from '@/store/app.store'
import { usePlaybackSessionStore } from '@/store/playback-session.store'
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

function hasDiscordBridge(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.api?.setDiscordRpcActivity === 'function' &&
    typeof window.api?.clearDiscordRpcActivity === 'function'
  )
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * Discord Rich Presenceを更新
 */
function send(payload: DiscordActivityPayload): void {
  if (!hasDiscordBridge()) return

  const { rpcEnabled, rpcClientId } = useAppStore.getState().accounts.discord
  if (!rpcEnabled) return

  window.api.setDiscordRpcActivity({
    ...payload,
    clientId: rpcClientId || undefined,
  })
}

/**
 * Discord Rich Presenceをクリア
 */
export function clearDiscordActivity(): void {
  if (!hasDiscordBridge()) return

  window.api.clearDiscordRpcActivity()
}

/**
 * 現在の曲情報をDiscordに送信
 */
export function sendCurrentSongToDiscord(): void {
  if (!hasDiscordBridge()) return

  const { playerState, songlist, actions } = usePlayerStore.getState()
  const playbackSession = usePlaybackSessionStore.getState()

  const mediaType = playbackSession.mediaType ?? playerState.mediaType
  if (mediaType !== 'song') return

  const currentSong = songlist.currentSong
  const currentQueueItem = playbackSession.currentQueueItem
  const currentTime = Number.isFinite(actions.getCurrentProgress())
    ? actions.getCurrentProgress()
    : playbackSession.progress
  const isPlaying = playbackSession.isPlaying ?? playerState.isPlaying
  const currentDuration =
    playerState.currentDuration > 0
      ? playerState.currentDuration
      : playbackSession.currentDuration > 0
        ? playbackSession.currentDuration
        : currentQueueItem?.durationSeconds ?? 0

  // 停止中または曲がない場合はクリア
  if (!isPlaying) {
    clearDiscordActivity()
    return
  }

  const trackName =
    normalizeText(currentSong?.title) || normalizeText(currentQueueItem?.title)
  const albumName =
    normalizeText(currentSong?.album) ||
    normalizeText(currentQueueItem?.albumTitle)
  const artistFromSong =
    currentSong?.artists && currentSong.artists.length > 0
      ? currentSong.artists.map((a) => a.name).join(', ')
      : currentSong?.artist
  const artist =
    normalizeText(artistFromSong) ||
    normalizeText(currentQueueItem?.primaryArtist)

  if (!trackName) {
    clearDiscordActivity()
    return
  }

  // アーティスト名を整形
  const currentTimeInMs = currentTime * 1000
  const durationInMs = currentDuration * 1000

  const startTime = Math.floor(Date.now() - currentTimeInMs)
  const endTime = Math.floor(Date.now() - currentTimeInMs + durationInMs)

  send({
    trackName,
    albumName,
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
  if (!hasDiscordBridge()) return false

  return useAppStore.getState().accounts.discord.rpcEnabled
}

// 後方互換性のためのエクスポート
export const discordRpc = {
  send: sendCurrentSongToDiscord,
  clear: clearDiscordActivity,
  sendCurrentSong: sendCurrentSongToDiscord,
}
