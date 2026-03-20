import { shallow } from 'zustand/shallow'
import {
  onPlayerAction,
  sendCurrentSongToDiscord,
  updatePlayerState,
} from '@/platform'
import { scrobble } from '@/service/scrobble'
import { IPlayerContext } from '@/types/playerContext'
import { isDesktop } from '@/utils/desktop'
import { idbStorage } from './idb'
import { PlaybackSessionState } from './playback-session.store'

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
    const { togglePlayPause, playPrevSong, playNextSong } =
      playerStore.getState().actions

    onPlayerAction((action) => {
      if (action === 'togglePlayPause') togglePlayPause()
      if (action === 'skipBackwards') playPrevSong()
      if (action === 'skipForward') playNextSong()
    })
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
