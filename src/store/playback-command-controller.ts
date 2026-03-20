import { LoopState } from '@/types/playerContext'

interface TogglePlayPauseOptions {
  isPlaying: boolean
  setPlayingState: (value: boolean) => void
}

interface PlayNextSongOptions {
  loopState: LoopState
  hasNextSong: () => boolean
  resetProgress: () => void
  playFirstSongInQueue: () => void
  setHasSyncedTheCurrentTrack: (value: boolean) => void
  setHasScrobbledTheCurrentTrack: (value: boolean) => void
  resetAccumulatedTime: () => void
  incrementSongIndex: () => void
}

interface PlayPrevSongOptions {
  hasPrevSong: () => boolean
  resetProgress: () => void
  resetAccumulatedTime: () => void
  setHasSyncedTheCurrentTrack: (value: boolean) => void
  setHasScrobbledTheCurrentTrack: (value: boolean) => void
  decrementSongIndex: () => void
}

interface HandleSongEndedOptions {
  loopState: LoopState
  hasNextSong: () => boolean
  playNextSong: () => void
  setPlayingState: (value: boolean) => void
  clearPlayerState: () => void
}

export function runTogglePlayPause({
  isPlaying,
  setPlayingState,
}: TogglePlayPauseOptions): void {
  setPlayingState(!isPlaying)
}

export function runPlayNextSong({
  loopState,
  hasNextSong,
  resetProgress,
  playFirstSongInQueue,
  setHasSyncedTheCurrentTrack,
  setHasScrobbledTheCurrentTrack,
  resetAccumulatedTime,
  incrementSongIndex,
}: PlayNextSongOptions): void {
  resetAccumulatedTime()
  setHasSyncedTheCurrentTrack(false)
  setHasScrobbledTheCurrentTrack(false)

  if (hasNextSong()) {
    resetProgress()
    incrementSongIndex()
    return
  }

  if (loopState === LoopState.All) {
    resetProgress()
    playFirstSongInQueue()
  }
}

export function runPlayPrevSong({
  hasPrevSong,
  resetProgress,
  resetAccumulatedTime,
  setHasSyncedTheCurrentTrack,
  setHasScrobbledTheCurrentTrack,
  decrementSongIndex,
}: PlayPrevSongOptions): void {
  if (!hasPrevSong()) {
    return
  }

  resetProgress()
  resetAccumulatedTime()
  setHasSyncedTheCurrentTrack(false)
  setHasScrobbledTheCurrentTrack(false)
  decrementSongIndex()
}

export function runHandleSongEnded({
  loopState,
  hasNextSong,
  playNextSong,
  setPlayingState,
  clearPlayerState,
}: HandleSongEndedOptions): void {
  if (hasNextSong() || loopState === LoopState.All) {
    playNextSong()
    setPlayingState(true)
    return
  }

  clearPlayerState()
  setPlayingState(false)
}
