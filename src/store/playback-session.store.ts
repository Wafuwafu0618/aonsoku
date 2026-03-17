import { shallow } from 'zustand/shallow'
import { createWithEqualityFn } from 'zustand/traditional'
import { LoopState } from '@/types/playerContext'

type MediaType = 'song' | 'radio' | 'podcast'

export interface PlaybackSessionValues {
  isPlaying: boolean
  loopState: LoopState
  isShuffleActive: boolean
  isSongStarred: boolean
  volume: number
  currentDuration: number
  mediaType: MediaType
  currentPlaybackRate: number
  hasPrev: boolean
  hasNext: boolean
  hasSyncedTheCurrentTrack: boolean
  hasScrobbledTheCurrentTrack: boolean
  progress: number
}

interface PlaybackSessionActions {
  sync: (values: Partial<PlaybackSessionValues>) => void
  reset: () => void
}

export interface PlaybackSessionState extends PlaybackSessionValues {
  actions: PlaybackSessionActions
}

const initialPlaybackSessionValues: PlaybackSessionValues = {
  isPlaying: false,
  loopState: LoopState.Off,
  isShuffleActive: false,
  isSongStarred: false,
  volume: 100,
  currentDuration: 0,
  mediaType: 'song',
  currentPlaybackRate: 1,
  hasPrev: false,
  hasNext: false,
  hasSyncedTheCurrentTrack: false,
  hasScrobbledTheCurrentTrack: false,
  progress: 0,
}

export const usePlaybackSessionStore =
  createWithEqualityFn<PlaybackSessionState>()(
    (set) => ({
      ...initialPlaybackSessionValues,
      actions: {
        sync: (values) => {
          set(values)
        },
        reset: () => {
          set(initialPlaybackSessionValues)
        },
      },
    }),
    shallow,
  )
