import { shallow } from 'zustand/shallow'
import { getSongStreamUrl } from '@/api/httpClient'
import type { QueueItem } from '@/domain/entities/queue-item'
import {
  onRemoteRelayCommand,
  onPlayerAction,
  remoteRelayUpdateState,
  sendCurrentSongToDiscord,
  updatePlayerState,
} from '@/platform'
import type { RemoteRelayStateUpdatePayload } from '@/platform/contracts/desktop-contract'
import { scrobble } from '@/service/scrobble'
import { enqueueLyricsPrefetch } from '@/service/lyrics-prefetch'
import { subsonic } from '@/service/subsonic'
import type { OversamplingTargetRatePolicy } from '@/oversampling/types'
import type { IPlayerContext } from '@/types/playerContext'
import { isDesktop } from '@/utils/desktop'
import { idbStorage } from './idb'
import type { PlaybackSessionState } from './playback-session.store'

interface PlayerStoreLike {
  getState: () => IPlayerContext
  subscribe: (...args: unknown[]) => () => void
}

interface PlaybackSessionStoreLike {
  getState: () => PlaybackSessionState
  subscribe: (...args: unknown[]) => () => void
}

interface InitializePlayerControllerOptions {
  playerStore: PlayerStoreLike
  playbackSessionStore: PlaybackSessionStoreLike
  songlistStorageKey: string
}

let initialized = false
let remoteRelayHeartbeatTimer: ReturnType<typeof setInterval> | null = null
let remoteRelayPausedTrackId: string | null = null
let remoteRelayPausedPositionSeconds = 0
let remoteRelayPendingPausedSeekSeconds: number | null = null
let lastPlayPauseToggleAtMs = 0

const REMOTE_RELAY_SEEK_SYNC_EPSILON_SECONDS = 1.0
const PLAY_PAUSE_TOGGLE_GUARD_MS = 350

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function canTogglePlayPauseNow(): boolean {
  const now = Date.now()
  if (now - lastPlayPauseToggleAtMs < PLAY_PAUSE_TOGGLE_GUARD_MS) {
    return false
  }
  lastPlayPauseToggleAtMs = now
  return true
}

function sanitizeProgressSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return value
}

function resolveRemoteRelayProgressSeconds(session: PlaybackSessionState): number {
  const progress = sanitizeProgressSeconds(session.progress)
  const trackId = session.currentQueueItem?.id ?? null

  if (session.mediaType !== 'song' || !trackId) {
    remoteRelayPausedTrackId = null
    remoteRelayPausedPositionSeconds = progress
    remoteRelayPendingPausedSeekSeconds = null
    return progress
  }

  if (session.isPlaying) {
    remoteRelayPausedTrackId = trackId
    remoteRelayPausedPositionSeconds = progress
    remoteRelayPendingPausedSeekSeconds = null
    return progress
  }

  if (remoteRelayPausedTrackId !== trackId) {
    remoteRelayPausedTrackId = trackId
    remoteRelayPausedPositionSeconds = progress
    remoteRelayPendingPausedSeekSeconds = null
    return progress
  }

  if (remoteRelayPendingPausedSeekSeconds !== null) {
    const pending = sanitizeProgressSeconds(remoteRelayPendingPausedSeekSeconds)
    const delta = Math.abs(progress - pending)
    if (delta <= REMOTE_RELAY_SEEK_SYNC_EPSILON_SECONDS) {
      remoteRelayPausedPositionSeconds = progress
      remoteRelayPendingPausedSeekSeconds = null
      return progress
    }

    // 再生停止中のシークは、エンジン反映前でも意図値を優先表示する
    remoteRelayPausedPositionSeconds = pending
    return pending
  }

  return remoteRelayPausedPositionSeconds
}

function buildLocalFileUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const fileUrl = normalizedPath.startsWith('/')
    ? `file://${normalizedPath}`
    : `file:///${normalizedPath}`
  return encodeURI(fileUrl)
}

function resolveRemoteRelaySource(
  queueItem: QueueItem | null,
): RemoteRelayStateUpdatePayload['source'] {
  if (!queueItem) return 'unsupported'
  if (queueItem.source === 'local') return 'local'
  if (queueItem.source === 'navidrome') return 'navidrome'
  return 'unsupported'
}

function resolveRemoteRelaySrc(queueItem: QueueItem | null): string | undefined {
  if (!queueItem) return undefined

  if (queueItem.source === 'local') {
    const localPath = queueItem.track.path
    if (typeof localPath !== 'string' || localPath.length === 0) return undefined
    return buildLocalFileUrl(localPath)
  }

  if (queueItem.source === 'navidrome') {
    if (typeof queueItem.sourceId !== 'string' || queueItem.sourceId.length === 0) {
      return undefined
    }
    return getSongStreamUrl(queueItem.sourceId)
  }

  return undefined
}

function resolveCodecLabel(queueItem: QueueItem | null): string | undefined {
  const suffix = queueItem?.track?.suffix?.trim()
  if (suffix && suffix.length > 0) {
    return suffix.toUpperCase()
  }

  const contentType = queueItem?.track?.contentType?.toLowerCase() ?? ''
  if (contentType.includes('flac')) return 'FLAC'
  if (contentType.includes('alac')) return 'ALAC'
  if (contentType.includes('aac')) return 'AAC'
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'MP3'
  if (contentType.includes('wav')) return 'WAV'

  return undefined
}

function resolveTargetRateFromPolicy(
  policy: OversamplingTargetRatePolicy,
  sourceSampleRateHz?: number,
): number | undefined {
  switch (policy) {
    case 'fixed-88200':
      return 88_200
    case 'fixed-96000':
      return 96_000
    case 'fixed-176400':
      return 176_400
    case 'fixed-192000':
      return 192_000
    case 'fixed-352800':
      return 352_800
    case 'fixed-384000':
      return 384_000
    case 'fixed-705600':
      return 705_600
    case 'fixed-768000':
      return 768_000
    case 'fixed-1411200':
      return 1_411_200
    case 'fixed-1536000':
      return 1_536_000
    case 'integer-family-max':
    default: {
      if (
        typeof sourceSampleRateHz !== 'number' ||
        !Number.isFinite(sourceSampleRateHz) ||
        sourceSampleRateHz <= 0
      ) {
        return undefined
      }
      return sourceSampleRateHz % 11_025 === 0 ? 352_800 : 384_000
    }
  }
}

function publishRemoteRelayState(
  playerStore: PlayerStoreLike,
  playbackSessionStore: PlaybackSessionStoreLike,
): void {
  const session = playbackSessionStore.getState()
  const queueItem = session.currentQueueItem
  const mediaType = session.mediaType
  const source = resolveRemoteRelaySource(queueItem)
  const src = mediaType === 'song' ? resolveRemoteRelaySrc(queueItem) : undefined
  const sourceCodec = mediaType === 'song' ? resolveCodecLabel(queueItem) : undefined
  const sourceSampleRateHz =
    mediaType === 'song' &&
    typeof queueItem?.track?.samplingRate === 'number' &&
    Number.isFinite(queueItem.track.samplingRate) &&
    queueItem.track.samplingRate > 0
      ? Math.trunc(queueItem.track.samplingRate)
      : undefined

  const oversamplingSettings = playerStore.getState().settings.oversampling.values
  const targetSampleRateHz =
    mediaType === 'song'
      ? oversamplingSettings.enabled
        ? resolveTargetRateFromPolicy(
            oversamplingSettings.targetRatePolicy,
            sourceSampleRateHz,
          )
        : sourceSampleRateHz
      : undefined
  const oversamplingFilterId =
    mediaType === 'song' && oversamplingSettings.enabled
      ? oversamplingSettings.presetId
      : undefined
  const relayProgressSeconds = resolveRemoteRelayProgressSeconds(session)

  remoteRelayUpdateState({
    mediaType,
    source,
    src,
    sourceCodec,
    sourceSampleRateHz,
    targetSampleRateHz,
    oversamplingFilterId,
    isPlaying: session.isPlaying,
    currentTimeSeconds: relayProgressSeconds,
    durationSeconds:
      session.currentDuration > 0
        ? session.currentDuration
        : (queueItem?.durationSeconds ?? 0),
    volume: session.volume,
    hasPrev: session.hasPrev,
    hasNext: session.hasNext,
    nowPlaying: queueItem
      ? {
          id: queueItem.id,
          title: queueItem.title,
          artist: queueItem.primaryArtist,
          album: queueItem.albumTitle,
          coverArtId: queueItem.coverArtId,
        }
      : undefined,
  })
}

export function initializePlayerController({
  playerStore,
  playbackSessionStore,
  songlistStorageKey,
}: InitializePlayerControllerOptions): void {
  if (initialized) return
  initialized = true

  playerStore.subscribe(
    (state: IPlayerContext) => [state.songlist],
    ([songlist]: [IPlayerContext['songlist']]) => {
      idbStorage.setItem(songlistStorageKey, songlist)
    },
    {
      equalityFn: shallow,
    },
  )

  playerStore.subscribe(
    (state: IPlayerContext) => [
      state.songlist.currentList,
      state.songlist.currentSongIndex,
    ],
    () => {
      const { mediaType } = playbackSessionStore.getState()
      if (mediaType === 'radio' || mediaType === 'podcast') return

      const store = playerStore.getState()

      store.actions.checkIsSongStarred()
      store.actions.setCurrentSong()

      const currentSong = store.songlist.currentSong
      if (
        typeof currentSong.id === 'string' &&
        currentSong.id.length > 0 &&
        typeof currentSong.artist === 'string' &&
        currentSong.artist.length > 0 &&
        typeof currentSong.title === 'string' &&
        currentSong.title.length > 0
      ) {
        enqueueLyricsPrefetch({
          id: currentSong.id,
          artist: currentSong.artist,
          title: currentSong.title,
          album: currentSong.album,
          duration: currentSong.duration,
        })
      }

      const isSonglistEmpty = store.songlist.currentList.length === 0

      if (isSonglistEmpty) {
        store.fullscreen.reset()
      }

      if (isSonglistEmpty && store.playerProgress.progress > 0) {
        store.actions.resetProgress()
      }
    },
    {
      equalityFn: shallow,
    },
  )

  playerStore.subscribe(
    (state: IPlayerContext) => [
      state.songlist.currentList,
      state.songlist.radioList,
      state.songlist.podcastList,
      state.songlist.currentSongIndex,
    ],
    () => {
      playerStore.getState().actions.updateQueueChecks()
    },
    {
      equalityFn: shallow,
    },
  )

  playerStore.subscribe(
    (state: IPlayerContext) => [state.songlist.currentSong],
    () => {
      sendCurrentSongToDiscord()
    },
    {
      equalityFn: shallow,
    },
  )

  playbackSessionStore.subscribe(
    (state: PlaybackSessionState) => [state.isPlaying, state.currentDuration],
    () => {
      sendCurrentSongToDiscord()
    },
    {
      equalityFn: shallow,
    },
  )

  playerStore.subscribe((state: IPlayerContext, prevState: IPlayerContext) => {
    const currentSong = state.songlist.currentSong ?? null
    if (!currentSong) return

    const progress = state.playerProgress.progress
    const prevProgress = prevState.playerProgress.progress
    const duration = currentSong.duration
    const { isPlaying, hasSyncedTheCurrentTrack, hasScrobbledTheCurrentTrack } =
      playbackSessionStore.getState()

    if (progress >= 1 && prevProgress < 1 && !hasSyncedTheCurrentTrack) {
      playerStore.getState().actions.setHasSyncedTheCurrentTrack(true)
      scrobble.send(currentSong.id, false)
    }

    const timeDelta = progress - prevProgress

    if (isPlaying && timeDelta > 0 && timeDelta <= 2) {
      playerStore.getState().actions.incrementAccumulatedTime(timeDelta)
    }

    const accumulatedTime = playerStore.getState().listenTime.accumulated
    const targetTime = Math.min(duration / 2, 60 * 4)

    if (
      duration > 0 &&
      accumulatedTime >= targetTime &&
      !hasScrobbledTheCurrentTrack
    ) {
      playerStore.getState().actions.setHasScrobbledTheCurrentTrack(true)
      scrobble.send(currentSong.id, true)
    }
  })

  if (isDesktop()) {
    const {
      togglePlayPause,
      playPrevSong,
      playNextSong,
      seekTo,
      setPlayingState,
      setSongList,
      setVolume,
    } = playerStore.getState().actions

    onPlayerAction((action) => {
      if (action === 'togglePlayPause') {
        if (!canTogglePlayPauseNow()) return
        togglePlayPause()
      }
      if (action === 'skipBackwards') playPrevSong()
      if (action === 'skipForward') playNextSong()
    })

    onRemoteRelayCommand((payload) => {
      if (payload.command === 'playPause') {
        if (!canTogglePlayPauseNow()) return
        togglePlayPause()
        return
      }

      if (payload.command === 'prev') {
        playPrevSong()
        return
      }

      if (payload.command === 'next') {
        playNextSong()
        return
      }

      if (payload.command === 'seek') {
        if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
          return
        }
        const duration = playbackSessionStore.getState().currentDuration
        const maxSeek = duration > 0 ? duration : Number.MAX_SAFE_INTEGER
        const seekSeconds = clamp(payload.value, 0, maxSeek)
        if (!playbackSessionStore.getState().isPlaying) {
          remoteRelayPendingPausedSeekSeconds = seekSeconds
          remoteRelayPausedPositionSeconds = seekSeconds
        }
        seekTo(seekSeconds)
        return
      }

      if (payload.command === 'setVolume') {
        if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
          return
        }
        setVolume(Math.round(clamp(payload.value, 0, 100)))
        return
      }

      if (payload.command === 'playAlbum') {
        if (typeof payload.albumId !== 'string' || payload.albumId.length === 0) {
          return
        }

        void (async () => {
          try {
            const album = await subsonic.albums.getOne(payload.albumId)
            const songs = album?.song ?? []
            if (songs.length === 0) return
            setSongList(songs, 0)
          } catch (error) {
            console.warn('[RemoteRelay] Failed to play album:', error)
          }
        })()
        return
      }

      if (payload.command === 'playSong') {
        if (
          typeof payload.albumId !== 'string' ||
          payload.albumId.length === 0 ||
          typeof payload.songId !== 'string' ||
          payload.songId.length === 0
        ) {
          return
        }

        void (async () => {
          try {
            const album = await subsonic.albums.getOne(payload.albumId)
            const songs = album?.song ?? []
            if (songs.length === 0) return
            const targetIndex = songs.findIndex((song) => song.id === payload.songId)
            setSongList(songs, targetIndex >= 0 ? targetIndex : 0)
          } catch (error) {
            console.warn('[RemoteRelay] Failed to play song:', error)
          }
        })()
      }
    })

    publishRemoteRelayState(playerStore, playbackSessionStore)

    playbackSessionStore.subscribe(
      (state: PlaybackSessionState) => [
        state.mediaType,
        state.isPlaying,
        state.progress,
        state.currentDuration,
        state.volume,
        state.hasPrev,
        state.hasNext,
        state.currentQueueItem,
      ],
      () => {
        publishRemoteRelayState(playerStore, playbackSessionStore)
      },
      {
        equalityFn: shallow,
      },
    )

    if (remoteRelayHeartbeatTimer) {
      clearInterval(remoteRelayHeartbeatTimer)
    }
    remoteRelayHeartbeatTimer = setInterval(() => {
      publishRemoteRelayState(playerStore, playbackSessionStore)
    }, 1000)
  }

  const updateDesktopState = () => {
    if (!isDesktop()) return

    const { isPlaying, hasPrev, hasNext } = playbackSessionStore.getState()
    const { currentList, podcastList, radioList } =
      playerStore.getState().songlist

    updatePlayerState({
      isPlaying,
      hasPrevious: hasPrev,
      hasNext,
      hasSonglist:
        currentList.length >= 1 ||
        podcastList.length >= 1 ||
        radioList.length >= 1,
    })
  }

  updateDesktopState()

  playbackSessionStore.subscribe(
    (state: PlaybackSessionState) => [
      state.isPlaying,
      state.hasPrev,
      state.hasNext,
    ],
    updateDesktopState,
    {
      equalityFn: shallow,
    },
  )

  playerStore.subscribe(
    (state: IPlayerContext) => [
      state.songlist.currentList,
      state.songlist.radioList,
      state.songlist.podcastList,
    ],
    updateDesktopState,
    {
      equalityFn: shallow,
    },
  )
}
