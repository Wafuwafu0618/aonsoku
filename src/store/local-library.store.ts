import { devtools, persist, subscribeWithSelector } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { shallow } from 'zustand/shallow'
import { createWithEqualityFn } from 'zustand/traditional'

type LocalLibraryStore = {
  directories: string[]
  isScanning: boolean
  progress: {
    totalFiles: number
    processedFiles: number
    foundTracks: number
    status: 'idle' | 'scanning' | 'paused' | 'completed' | 'error'
    currentFile?: string
    errorMessage?: string
  }
  lastScanAt: number | null
  actions: {
    addDirectory: (directory: string) => void
    removeDirectory: (directory: string) => void
    clearDirectories: () => void
    setScanning: (value: boolean) => void
    setProgress: (progress: LocalLibraryStore['progress']) => void
    setLastScanAt: (timestamp: number | null) => void
  }
}

function normalizeDirectoryPath(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

const initialProgress: LocalLibraryStore['progress'] = {
  totalFiles: 0,
  processedFiles: 0,
  foundTracks: 0,
  status: 'idle',
}

export const useLocalLibraryStore = createWithEqualityFn<LocalLibraryStore>()(
  subscribeWithSelector(
    persist(
      devtools(
        immer((set, get) => ({
          directories: [],
          isScanning: false,
          progress: initialProgress,
          lastScanAt: null,
          actions: {
            addDirectory: (directory) => {
              const normalizedNext = normalizeDirectoryPath(directory)
              const exists = get().directories.some(
                (item) => normalizeDirectoryPath(item) === normalizedNext,
              )

              if (exists) return

              set((state) => {
                state.directories.push(directory)
              })
            },
            removeDirectory: (directory) => {
              const normalizedTarget = normalizeDirectoryPath(directory)

              set((state) => {
                state.directories = state.directories.filter(
                  (item) => normalizeDirectoryPath(item) !== normalizedTarget,
                )
              })
            },
            clearDirectories: () => {
              set((state) => {
                state.directories = []
              })
            },
            setScanning: (value) => {
              set((state) => {
                state.isScanning = value
              })
            },
            setProgress: (progress) => {
              set((state) => {
                state.progress = progress
              })
            },
            setLastScanAt: (timestamp) => {
              set((state) => {
                state.lastScanAt = timestamp
              })
            },
          },
        })),
        {
          name: 'local_library_store',
        },
      ),
      {
        name: 'local_library_store',
        version: 1,
        partialize: (state) => ({
          directories: state.directories,
          lastScanAt: state.lastScanAt,
        }),
      },
    ),
  ),
  shallow,
)

export const useLocalLibraryDirectories = () =>
  useLocalLibraryStore((state) => state.directories)

export const useLocalLibraryStatus = () =>
  useLocalLibraryStore((state) => ({
    isScanning: state.isScanning,
    progress: state.progress,
    lastScanAt: state.lastScanAt,
  }))

export const useLocalLibraryActions = () =>
  useLocalLibraryStore((state) => state.actions)
