/**
 * Local Library IndexedDB Repository
 *
 * - Track persistence
 * - Full-text search index
 * - Scan metadata persistence
 */

import type { LocalTrack } from './types'

const DB_NAME = 'AonsokuLocalLibrary'
const DB_VERSION = 2

const STORES = {
  TRACKS: 'tracks',
  FILE_PATHS: 'filePaths',
  SEARCH_INDEX: 'searchIndex',
  METADATA: 'metadata',
  LYRICS: 'lyrics',
} as const

export interface TrackPageResult {
  tracks: LocalTrack[]
  total: number
}

export type LyricsCacheStatus = 'found' | 'not_found' | 'error'
export type LyricsCacheSource = 'lrclib' | 'subsonic'

export interface LyricsLookupInput {
  artist: string
  title: string
  album?: string
  duration?: number
  preferSyncedLyrics: boolean
  songLyricsEnabled: boolean
}

export interface LyricsCacheRecord {
  lookupKey: string
  trackId?: string
  artist: string
  title: string
  album?: string
  duration?: number
  preferSyncedLyrics: boolean
  songLyricsEnabled: boolean
  status: LyricsCacheStatus
  value?: string
  synced?: boolean
  source?: LyricsCacheSource
  failureCount: number
  nextRetryAt: number
  updatedAt: number
  lastError?: string
}

export interface LyricsCacheStats {
  total: number
  found: number
  notFound: number
  error: number
}

interface LyricsCacheMutationInput extends LyricsLookupInput {
  lookupKey?: string
  trackId?: string
}

interface MarkLyricsErrorInput extends LyricsCacheMutationInput {
  errorMessage: string
}

const LYRICS_NOT_FOUND_RETRY_MS = 24 * 60 * 60 * 1000
const LYRICS_ERROR_BACKOFF_MS = [
  5 * 60 * 1000,
  30 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const

async function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      if (!db.objectStoreNames.contains(STORES.TRACKS)) {
        const tracksStore = db.createObjectStore(STORES.TRACKS, {
          keyPath: 'id',
        })
        tracksStore.createIndex('sourceId', 'sourceId', { unique: true })
        tracksStore.createIndex('filePath', 'filePath', { unique: true })
        tracksStore.createIndex('artist', 'artist', { unique: false })
        tracksStore.createIndex('album', 'album', { unique: false })
        tracksStore.createIndex('title', 'title', { unique: false })
        tracksStore.createIndex('modifiedAt', 'modifiedAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(STORES.FILE_PATHS)) {
        const pathsStore = db.createObjectStore(STORES.FILE_PATHS, {
          keyPath: 'path',
        })
        pathsStore.createIndex('trackId', 'trackId', { unique: false })
        pathsStore.createIndex('lastModified', 'lastModified', {
          unique: false,
        })
      }

      if (!db.objectStoreNames.contains(STORES.SEARCH_INDEX)) {
        const searchStore = db.createObjectStore(STORES.SEARCH_INDEX, {
          keyPath: 'word',
        })
        searchStore.createIndex('trackIds', 'trackIds', {
          unique: false,
          multiEntry: true,
        })
      }

      if (!db.objectStoreNames.contains(STORES.METADATA)) {
        db.createObjectStore(STORES.METADATA, {
          keyPath: 'key',
        })
      }

      if (!db.objectStoreNames.contains(STORES.LYRICS)) {
        const lyricsStore = db.createObjectStore(STORES.LYRICS, {
          keyPath: 'lookupKey',
        })
        lyricsStore.createIndex('status', 'status', { unique: false })
        lyricsStore.createIndex('updatedAt', 'updatedAt', { unique: false })
        lyricsStore.createIndex('nextRetryAt', 'nextRetryAt', { unique: false })
        lyricsStore.createIndex('trackId', 'trackId', { unique: false })
      }
    }
  })
}

export async function saveTrack(track: LocalTrack): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(
    [STORES.TRACKS, STORES.FILE_PATHS],
    'readwrite',
  )

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const tracksStore = transaction.objectStore(STORES.TRACKS)
    tracksStore.put(track)

    const pathsStore = transaction.objectStore(STORES.FILE_PATHS)
    pathsStore.put({
      path: track.filePath,
      trackId: track.id,
      lastModified: track.modifiedAt,
    })
  })
}

export async function saveTracksBatch(tracks: LocalTrack[]): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(
    [STORES.TRACKS, STORES.FILE_PATHS],
    'readwrite',
  )

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const tracksStore = transaction.objectStore(STORES.TRACKS)
    const pathsStore = transaction.objectStore(STORES.FILE_PATHS)

    for (const track of tracks) {
      tracksStore.put(track)
      pathsStore.put({
        path: track.filePath,
        trackId: track.id,
        lastModified: track.modifiedAt,
      })
    }
  })
}

export async function getTrack(id: string): Promise<LocalTrack | undefined> {
  const db = await getDB()
  const transaction = db.transaction(STORES.TRACKS, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.TRACKS)
    const request = store.get(id)

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getAllTracks(): Promise<LocalTrack[]> {
  const db = await getDB()
  const transaction = db.transaction(STORES.TRACKS, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.TRACKS)
    const request = store.getAll()

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getTracksCount(): Promise<number> {
  const db = await getDB()
  const transaction = db.transaction(STORES.TRACKS, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.TRACKS)
    const request = store.count()

    request.onsuccess = () => resolve(request.result ?? 0)
    request.onerror = () => reject(request.error)
  })
}

export async function getTracksPage(
  offset: number,
  limit: number,
): Promise<TrackPageResult> {
  const normalizedOffset = Math.max(0, offset)
  const normalizedLimit = Math.max(0, limit)

  const db = await getDB()
  const transaction = db.transaction(STORES.TRACKS, 'readonly')
  const store = transaction.objectStore(STORES.TRACKS)

  const totalPromise = new Promise<number>((resolve, reject) => {
    const countRequest = store.count()
    countRequest.onsuccess = () => resolve(countRequest.result ?? 0)
    countRequest.onerror = () => reject(countRequest.error)
  })

  const tracksPromise = new Promise<LocalTrack[]>((resolve, reject) => {
    if (normalizedLimit === 0) {
      resolve([])
      return
    }

    const tracks: LocalTrack[] = []
    let advanced = normalizedOffset === 0
    const cursorRequest = store.openCursor()

    cursorRequest.onerror = () => reject(cursorRequest.error)
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve(tracks)
        return
      }

      if (!advanced) {
        advanced = true
        cursor.advance(normalizedOffset)
        return
      }

      tracks.push(cursor.value as LocalTrack)
      if (tracks.length >= normalizedLimit) {
        resolve(tracks)
        return
      }

      cursor.continue()
    }
  })

  const [total, tracks] = await Promise.all([totalPromise, tracksPromise])

  return {
    tracks,
    total,
  }
}

export async function getTrackByFilePath(
  filePath: string,
): Promise<LocalTrack | undefined> {
  const db = await getDB()
  const transaction = db.transaction(STORES.TRACKS, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.TRACKS)
    const index = store.index('filePath')
    const request = index.get(filePath)

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function deleteTrack(id: string): Promise<void> {
  const track = await getTrack(id)
  if (!track) return

  const db = await getDB()
  const transaction = db.transaction(
    [STORES.TRACKS, STORES.FILE_PATHS],
    'readwrite',
  )

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const tracksStore = transaction.objectStore(STORES.TRACKS)
    tracksStore.delete(id)

    const pathsStore = transaction.objectStore(STORES.FILE_PATHS)
    pathsStore.delete(track.filePath)
  })
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  const normalizedPath = normalizePathForCompare(path)
  const normalizedDirectory = normalizePathForCompare(directory)

  if (!normalizedDirectory) return false

  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}\\`)
  )
}

export async function removeTracksByDirectory(
  directoryPath: string,
  retainedDirectories: string[] = [],
): Promise<{ removedTracks: number; remainingTracks: number }> {
  const tracks = await getAllTracks()

  const tracksToRemove = tracks.filter((track) => {
    if (!isPathWithinDirectory(track.filePath, directoryPath)) {
      return false
    }

    const shouldKeep = retainedDirectories.some((directory) =>
      isPathWithinDirectory(track.filePath, directory),
    )

    return !shouldKeep
  })

  if (tracksToRemove.length === 0) {
    return {
      removedTracks: 0,
      remainingTracks: tracks.length,
    }
  }

  const removedTrackIds = new Set(tracksToRemove.map((track) => track.id))
  const remainingTracks = tracks.filter((track) => !removedTrackIds.has(track.id))

  const db = await getDB()
  const transaction = db.transaction(
    [STORES.TRACKS, STORES.FILE_PATHS],
    'readwrite',
  )

  await new Promise<void>((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const tracksStore = transaction.objectStore(STORES.TRACKS)
    const filePathsStore = transaction.objectStore(STORES.FILE_PATHS)

    for (const track of tracksToRemove) {
      tracksStore.delete(track.id)
      filePathsStore.delete(track.filePath)
    }
  })

  await buildSearchIndex(remainingTracks)

  return {
    removedTracks: tracksToRemove.length,
    remainingTracks: remainingTracks.length,
  }
}

export async function clearAllTracks(): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(
    [STORES.TRACKS, STORES.FILE_PATHS],
    'readwrite',
  )

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    transaction.objectStore(STORES.TRACKS).clear()
    transaction.objectStore(STORES.FILE_PATHS).clear()
  })
}

export async function buildSearchIndex(tracks: LocalTrack[]): Promise<void> {
  const wordMap = new Map<string, Set<string>>()

  for (const track of tracks) {
    const words = extractWords(`${track.title} ${track.artist} ${track.album}`)
    for (const word of words) {
      if (!wordMap.has(word)) {
        wordMap.set(word, new Set())
      }
      wordMap.get(word)?.add(track.id)
    }
  }

  const db = await getDB()
  const transaction = db.transaction(STORES.SEARCH_INDEX, 'readwrite')

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const store = transaction.objectStore(STORES.SEARCH_INDEX)
    store.clear()

    for (const [word, trackIds] of wordMap) {
      store.put({
        word,
        trackIds: Array.from(trackIds),
      })
    }
  })
}

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2)
}

async function getSearchTrackIds(query: string): Promise<string[]> {
  const words = extractWords(query)
  if (words.length === 0) return []

  const db = await getDB()
  const transaction = db.transaction(STORES.SEARCH_INDEX, 'readonly')

  const trackIdLists = await Promise.all(
    words.map((word) => {
      return new Promise<string[]>((resolve, reject) => {
        const store = transaction.objectStore(STORES.SEARCH_INDEX)
        const request = store.get(word)

        request.onsuccess = () => {
          const result = request.result
          resolve((result?.trackIds as string[] | undefined) ?? [])
        }
        request.onerror = () => reject(request.error)
      })
    }),
  )

  const [firstList, ...restLists] = trackIdLists
  if (!firstList || firstList.length === 0) return []

  const restIdSets = restLists.map((ids) => new Set(ids))
  const seen = new Set<string>()

  return firstList.filter((id) => {
    if (seen.has(id)) return false
    const existsInAll = restIdSets.every((idSet) => idSet.has(id))
    if (!existsInAll) return false
    seen.add(id)
    return true
  })
}

async function getTracksByIds(trackIds: string[]): Promise<LocalTrack[]> {
  if (trackIds.length === 0) return []

  const db = await getDB()
  const transaction = db.transaction(STORES.TRACKS, 'readonly')
  const store = transaction.objectStore(STORES.TRACKS)

  const result = await Promise.all(
    trackIds.map((id) => {
      return new Promise<LocalTrack | undefined>((resolve, reject) => {
        const request = store.get(id)
        request.onsuccess = () => resolve(request.result as LocalTrack)
        request.onerror = () => reject(request.error)
      })
    }),
  )

  return result.filter((track): track is LocalTrack => track !== undefined)
}

export async function searchTracks(query: string): Promise<LocalTrack[]> {
  const { tracks } = await searchTracksPage(query, 0, Number.MAX_SAFE_INTEGER)
  return tracks
}

export async function searchTracksCount(query: string): Promise<number> {
  const trackIds = await getSearchTrackIds(query)
  return trackIds.length
}

export async function searchTracksPage(
  query: string,
  offset: number,
  limit: number,
): Promise<TrackPageResult> {
  const normalizedOffset = Math.max(0, offset)
  const normalizedLimit = Math.max(0, limit)

  const trackIds = await getSearchTrackIds(query)
  const total = trackIds.length

  if (normalizedLimit === 0 || total === 0) {
    return {
      tracks: [],
      total,
    }
  }

  const pagedTrackIds = trackIds.slice(
    normalizedOffset,
    normalizedOffset + normalizedLimit,
  )
  const tracks = await getTracksByIds(pagedTrackIds)

  return {
    tracks,
    total,
  }
}

export async function getAllFilePaths(): Promise<
  Array<{
    path: string
    trackId: string
    lastModified: number
  }>
> {
  const db = await getDB()
  const transaction = db.transaction(STORES.FILE_PATHS, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.FILE_PATHS)
    const request = store.getAll()

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getLibraryStats(): Promise<{
  totalTracks: number
  totalArtists: number
  totalAlbums: number
  totalDuration: number
}> {
  const tracks = await getAllTracks()

  const artists = new Set(tracks.map((track) => track.artist))
  const albums = new Set(tracks.map((track) => `${track.album}-${track.artist}`))
  const totalDuration = tracks.reduce(
    (sum, track) => sum + (track.duration || 0),
    0,
  )

  return {
    totalTracks: tracks.length,
    totalArtists: artists.size,
    totalAlbums: albums.size,
    totalDuration,
  }
}

export async function getLastScanTime(): Promise<number | null> {
  const db = await getDB()
  const transaction = db.transaction(STORES.METADATA, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.METADATA)
    const request = store.get('lastScanTime')

    request.onsuccess = () => {
      resolve(request.result?.value || null)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function setLastScanTime(timestamp: number): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(STORES.METADATA, 'readwrite')

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const store = transaction.objectStore(STORES.METADATA)
    store.put({
      key: 'lastScanTime',
      value: timestamp,
    })
  })
}

export async function getMetadataValue<T = unknown>(
  key: string,
): Promise<T | undefined> {
  const db = await getDB()
  const transaction = db.transaction(STORES.METADATA, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.METADATA)
    const request = store.get(key)

    request.onsuccess = () => {
      resolve(request.result?.value as T | undefined)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function setMetadataValue(
  key: string,
  value: unknown,
): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(STORES.METADATA, 'readwrite')

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const store = transaction.objectStore(STORES.METADATA)
    store.put({
      key,
      value,
    })
  })
}

function normalizeLyricsLookupText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeLyricsLookupDuration(duration: number | undefined): string {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return ''
  }

  return String(Math.round(duration))
}

function encodeLyricsLookupPart(value: string): string {
  return encodeURIComponent(value)
}

function getLyricsErrorBackoffMs(failureCount: number): number {
  const normalizedCount = Math.max(1, failureCount)
  const index = Math.min(
    LYRICS_ERROR_BACKOFF_MS.length - 1,
    normalizedCount - 1,
  )
  return LYRICS_ERROR_BACKOFF_MS[index]
}

export function createLyricsLookupKey(input: LyricsLookupInput): string {
  const parts = [
    'lyrics',
    normalizeLyricsLookupText(input.artist),
    normalizeLyricsLookupText(input.title),
    normalizeLyricsLookupText(input.album),
    normalizeLyricsLookupDuration(input.duration),
    input.preferSyncedLyrics ? 'synced' : 'plain',
    input.songLyricsEnabled ? 'internal' : 'external',
  ]

  return parts.map(encodeLyricsLookupPart).join(':')
}

export async function getLyricsByLookupKey(
  lookupKey: string,
): Promise<LyricsCacheRecord | undefined> {
  const db = await getDB()
  const transaction = db.transaction(STORES.LYRICS, 'readonly')

  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORES.LYRICS)
    const request = store.get(lookupKey)

    request.onsuccess = () =>
      resolve(request.result as LyricsCacheRecord | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function upsertLyrics(record: LyricsCacheRecord): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(STORES.LYRICS, 'readwrite')

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const store = transaction.objectStore(STORES.LYRICS)
    store.put(record)
  })
}

export async function markLyricsNotFound(
  input: LyricsCacheMutationInput,
): Promise<void> {
  const lookupKey = input.lookupKey ?? createLyricsLookupKey(input)
  const previousRecord = await getLyricsByLookupKey(lookupKey)
  const now = Date.now()

  await upsertLyrics({
    lookupKey,
    trackId: input.trackId ?? previousRecord?.trackId,
    artist: input.artist,
    title: input.title,
    album: input.album,
    duration: input.duration,
    preferSyncedLyrics: input.preferSyncedLyrics,
    songLyricsEnabled: input.songLyricsEnabled,
    status: 'not_found',
    failureCount: 0,
    nextRetryAt: now + LYRICS_NOT_FOUND_RETRY_MS,
    updatedAt: now,
  })
}

export async function markLyricsError(
  input: MarkLyricsErrorInput,
): Promise<void> {
  const lookupKey = input.lookupKey ?? createLyricsLookupKey(input)
  const previousRecord = await getLyricsByLookupKey(lookupKey)
  const failureCount = Math.max(1, (previousRecord?.failureCount ?? 0) + 1)
  const now = Date.now()

  await upsertLyrics({
    lookupKey,
    trackId: input.trackId ?? previousRecord?.trackId,
    artist: input.artist,
    title: input.title,
    album: input.album,
    duration: input.duration,
    preferSyncedLyrics: input.preferSyncedLyrics,
    songLyricsEnabled: input.songLyricsEnabled,
    status: 'error',
    failureCount,
    nextRetryAt: now + getLyricsErrorBackoffMs(failureCount),
    updatedAt: now,
    lastError: input.errorMessage.trim() || 'Unknown error',
  })
}

export function shouldRetryLyricsFetch(
  record: LyricsCacheRecord | undefined,
  nowMs = Date.now(),
): boolean {
  if (!record) return true
  if (record.status === 'found') return false

  if (!Number.isFinite(record.nextRetryAt) || record.nextRetryAt <= 0) {
    return true
  }

  return nowMs >= record.nextRetryAt
}

export async function clearLyricsCache(): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(STORES.LYRICS, 'readwrite')

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const store = transaction.objectStore(STORES.LYRICS)
    store.clear()
  })
}

export async function getLyricsCacheStats(): Promise<LyricsCacheStats> {
  const db = await getDB()
  const transaction = db.transaction(STORES.LYRICS, 'readonly')
  const store = transaction.objectStore(STORES.LYRICS)
  const statusIndex = store.index('status')

  const countRequest = (source: IDBObjectStore | IDBIndex, key?: IDBValidKey) =>
    new Promise<number>((resolve, reject) => {
      const request = key !== undefined ? source.count(key) : source.count()
      request.onsuccess = () => resolve(request.result ?? 0)
      request.onerror = () => reject(request.error)
    })

  const [total, found, notFound, error] = await Promise.all([
    countRequest(store),
    countRequest(statusIndex, 'found'),
    countRequest(statusIndex, 'not_found'),
    countRequest(statusIndex, 'error'),
  ])

  return {
    total,
    found,
    notFound,
    error,
  }
}
