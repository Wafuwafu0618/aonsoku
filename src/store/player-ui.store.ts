import { shallow } from 'zustand/shallow'
import { createWithEqualityFn } from 'zustand/traditional'

interface PlayerUiActions {
  setMainDrawerState: (value: boolean) => void
  setQueueState: (value: boolean) => void
  setLyricsState: (value: boolean) => void
  toggleQueueAction: () => void
  toggleLyricsAction: () => void
  toggleQueueAndLyrics: () => void
  closeDrawer: () => void
  setIsFullscreen: (value: boolean) => void
  resetFullscreen: () => void
}

interface PlayerUiState {
  mainDrawerState: boolean
  queueState: boolean
  lyricsState: boolean
  isFullscreen: boolean
  actions: PlayerUiActions
}

export const usePlayerUiStore = createWithEqualityFn<PlayerUiState>()(
  (set, get) => ({
    mainDrawerState: false,
    queueState: false,
    lyricsState: false,
    isFullscreen: false,
    actions: {
      setMainDrawerState: (value) => {
        set({ mainDrawerState: value })
      },
      setQueueState: (value) => {
        set({ queueState: value })
      },
      setLyricsState: (value) => {
        set({ lyricsState: value })
      },
      toggleQueueAction: () => {
        const { mainDrawerState, lyricsState, queueState, actions } = get()

        if (mainDrawerState && lyricsState) {
          actions.toggleQueueAndLyrics()
          return
        }

        set({
          queueState: !queueState,
          mainDrawerState: !mainDrawerState,
        })
      },
      toggleLyricsAction: () => {
        const { mainDrawerState, lyricsState, queueState, actions } = get()

        if (mainDrawerState && queueState) {
          actions.toggleQueueAndLyrics()
          return
        }

        set({
          lyricsState: !lyricsState,
          mainDrawerState: !mainDrawerState,
        })
      },
      toggleQueueAndLyrics: () => {
        const { queueState, lyricsState } = get()

        set({
          queueState: !queueState,
          lyricsState: !lyricsState,
        })
      },
      closeDrawer: () => {
        set({
          mainDrawerState: false,
          queueState: false,
          lyricsState: false,
        })
      },
      setIsFullscreen: (value) => {
        set({ isFullscreen: value })
      },
      resetFullscreen: () => {
        set({ isFullscreen: false })
      },
    },
  }),
  shallow,
)
