import { shallow } from 'zustand/shallow'
import { IPlayerContext } from '@/types/playerContext'
import {
  PlaybackSessionState,
  PlaybackSessionValues,
} from './playback-session.store'

interface PlayerStoreLike {
  getState: () => IPlayerContext
  subscribe: (...args: unknown[]) => () => void
}

interface PlaybackSessionStoreLike {
  getState: () => PlaybackSessionState
  subscribe: (...args: unknown[]) => () => void
}

interface InitializePlaybackSessionBridgeOptions {
  playerStore: PlayerStoreLike
  playbackSessionStore: PlaybackSessionStoreLike
}

let initialized = false

function mapPlayerStoreToPlaybackSessionValues(
  state: IPlayerContext,
): PlaybackSessionValues {
  return {
    isPlaying: state.playerState.isPlaying,
    loopState: state.playerState.loopState,
    isShuffleActive: state.playerState.isShuffleActive,
    isSongStarred: state.playerState.isSongStarred,
    volume: state.playerState.volume,
    currentDuration: state.playerState.currentDuration,
    mediaType: state.playerState.mediaType,
    currentPlaybackRate: state.playerState.currentPlaybackRate,
    hasPrev: state.playerState.hasPrev,
    hasNext: state.playerState.hasNext,
    hasSyncedTheCurrentTrack: state.playerState.hasSyncedTheCurrentTrack,
    hasScrobbledTheCurrentTrack: state.playerState.hasScrobbledTheCurrentTrack,
    progress: state.playerProgress.progress,
  }
}

export function initializePlaybackSessionBridge({
  playerStore,
  playbackSessionStore,
}: InitializePlaybackSessionBridgeOptions): void {
  if (initialized) return
  initialized = true

  const syncPlaybackSessionState = () => {
    const playerStoreState = playerStore.getState()

    playbackSessionStore
      .getState()
      .actions.sync(mapPlayerStoreToPlaybackSessionValues(playerStoreState))
  }

  syncPlaybackSessionState()

  playerStore.subscribe(
    (state: IPlayerContext) => [
      state.playerState.isPlaying,
      state.playerState.loopState,
      state.playerState.isShuffleActive,
      state.playerState.isSongStarred,
      state.playerState.volume,
      state.playerState.currentDuration,
      state.playerState.mediaType,
      state.playerState.currentPlaybackRate,
      state.playerState.hasPrev,
      state.playerState.hasNext,
      state.playerState.hasSyncedTheCurrentTrack,
      state.playerState.hasScrobbledTheCurrentTrack,
      state.playerProgress.progress,
    ],
    syncPlaybackSessionState,
    {
      equalityFn: shallow,
    },
  )
}
