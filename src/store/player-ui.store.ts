import { shallow } from 'zustand/shallow'
import { createWithEqualityFn } from 'zustand/traditional'

interface PlayerUiActions {
  setMainDrawerState: (value: boolean) => void
  setQueueState: (value: boolean) => void
  setLyricsState: (value: boolean) => void
  setLyricsSidebarState: (value: boolean) => void
  toggleQueueAction: () => void
  toggleLyricsAction: () => void
  toggleLyricsSidebarAction: () => void
  toggleQueueAndLyrics: () => void
  closeDrawer: () => void
  setIsFullscreen: (value: boolean) => void
  resetFullscreen: () => void
}

interface PlayerUiState {
  mainDrawerState: boolean
  queueState: boolean
  lyricsState: boolean
  lyricsSidebarState: boolean
  isFullscreen: boolean
  actions: PlayerUiActions
}

export const usePlayerUiStore = createWithEqualityFn<PlayerUiState>()(
  (set, get) => ({
    mainDrawerState: false,
    queueState: false,
    lyricsState: false,
    lyricsSidebarState: false,
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
      setLyricsSidebarState: (value) => {
        set({
          lyricsSidebarState: value,
          mainDrawerState: value ? false : get().mainDrawerState,
          queueState: value ? false : get().queueState,
          lyricsState: value ? false : get().lyricsState,
        })
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
          lyricsSidebarState: false,
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
      toggleLyricsSidebarAction: () => {
        const { lyricsSidebarState } = get()

        set({
          lyricsSidebarState: !lyricsSidebarState,
          mainDrawerState: false,
          queueState: false,
          lyricsState: false,
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
