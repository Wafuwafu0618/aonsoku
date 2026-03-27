import { useAppStore } from '@/store/app.store'
import { usePlaybackSessionStore } from '@/store/playback-session.store'
import { usePlayerStore } from '@/store/player.store'
import { ISong } from '@/types/responses/song'

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

function send(song: ISong, currentTime = 0, duration = 0) {
  if (!hasDiscordBridge()) return

  const { rpcEnabled, rpcClientId } = useAppStore.getState().accounts.discord
  if (!rpcEnabled) return

  const currentTimeInMs = currentTime * 1000
  const durationInMs = duration * 1000

  const artist = song.artists
    ? song.artists.map((artist) => artist.name).join(', ')
    : song.artist

  const startTime = Math.floor(Date.now() - currentTimeInMs)
  const endTime = Math.floor(Date.now() - currentTimeInMs + durationInMs)

  window.api.setDiscordRpcActivity({
    trackName: song.title,
    albumName: song.album,
    artist,
    startTime,
    endTime,
    duration,
    clientId: rpcClientId || undefined,
  })
}

function clear() {
  if (!hasDiscordBridge()) return

  window.api.clearDiscordRpcActivity()
}

function sendCurrentSong() {
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

  if (!isPlaying) {
    discordRpc.clear()
    return
  }

  const title =
    normalizeText(currentSong?.title) || normalizeText(currentQueueItem?.title)
  const artistFromSong =
    currentSong?.artists && currentSong.artists.length > 0
      ? currentSong.artists.map((artist) => artist.name).join(', ')
      : currentSong?.artist
  const artist =
    normalizeText(artistFromSong) ||
    normalizeText(currentQueueItem?.primaryArtist)
  const album =
    normalizeText(currentSong?.album) ||
    normalizeText(currentQueueItem?.albumTitle)

  if (!title) {
    discordRpc.clear()
    return
  }

  const songPayload = {
    ...(currentSong ?? ({} as ISong)),
    title,
    artist,
    album,
    artists: currentSong?.artists,
  } as ISong

  discordRpc.send(songPayload, currentTime, currentDuration)
}

export const discordRpc = {
  send,
  clear,
  sendCurrentSong,
}
