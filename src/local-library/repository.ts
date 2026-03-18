/**
 * Local Library IndexedDB Repository
 *
 * IndexedDBを使用したローカル曲データの永続化
 * - 巨大ライブラリ対応（全文検索インデックス）
 * - 増分更新対応
 */

import type { LocalTrack, ScanError } from '../types'

const DB_NAME = 'AonsokuLocalLibrary'
const DB_VERSION = 1

// ストア名
const STORES = {
  TRACKS: 'tracks',
  FILE_PATHS: 'filePaths',
  SEARCH_INDEX: 'searchIndex',
  METADATA: 'metadata',
} as const

/**
 * IndexedDB接続を取得
 */
async function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // tracksストア: メタデータ本体
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

      // filePathsストア: ファイルパスと変更検知
      if (!db.objectStoreNames.contains(STORES.FILE_PATHS)) {
        const pathsStore = db.createObjectStore(STORES.FILE_PATHS, {
          keyPath: 'path',
        })
        pathsStore.createIndex('trackId', 'trackId', { unique: false })
        pathsStore.createIndex('lastModified', 'lastModified', {
          unique: false,
        })
      }

      // searchIndexストア: 全文検索インデックス
      if (!db.objectStoreNames.contains(STORES.SEARCH_INDEX)) {
        const searchStore = db.createObjectStore(STORES.SEARCH_INDEX, {
          keyPath: 'word',
        })
        searchStore.createIndex('trackIds', 'trackIds', {
          unique: false,
          multiEntry: true,
        })
      }

      // metadataストア: ライブラリ全体のメタデータ
      if (!db.objectStoreNames.contains(STORES.METADATA)) {
        db.createObjectStore(STORES.METADATA, {
          keyPath: 'key',
        })
      }
    }
  })
}

/**
 * トランザクションヘルパー
 */
async function withTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  callback: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await getDB()
  const transaction = db.transaction(storeNames, mode)

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => {
      // callbackの結果を待つ
    }

    callback(transaction).then(resolve).catch(reject)
  })
}

/**
 * トラックを保存
 */
export async function saveTrack(track: LocalTrack): Promise<void> {
  const db = await getDB()
  const transaction = db.transaction(
    [STORES.TRACKS, STORES.FILE_PATHS],
    'readwrite',
  )

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    // tracksストアに保存
    const tracksStore = transaction.objectStore(STORES.TRACKS)
    tracksStore.put(track)

    // filePathsストアに保存
    const pathsStore = transaction.objectStore(STORES.FILE_PATHS)
    pathsStore.put({
      path: track.filePath,
      trackId: track.id,
      lastModified: track.modifiedAt,
    })
  })
}

/**
 * 複数トラックをバッチ保存
 */
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

/**
 * トラックを取得
 */
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

/**
 * 全トラックを取得
 */
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

/**
 * ファイルパスからトラックを取得
 */
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

/**
 * トラックを削除
 */
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

/**
 * 全トラックを削除
 */
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

/**
 * 検索インデックスを構築
 */
export async function buildSearchIndex(tracks: LocalTrack[]): Promise<void> {
  const wordMap = new Map<string, Set<string>>()

  // 各トラックから単語を抽出
  for (const track of tracks) {
    const words = extractWords(`${track.title} ${track.artist} ${track.album}`)
    for (const word of words) {
      if (!wordMap.has(word)) {
        wordMap.set(word, new Set())
      }
      wordMap.get(word)!.add(track.id)
    }
  }

  // IndexedDBに保存
  const db = await getDB()
  const transaction = db.transaction(STORES.SEARCH_INDEX, 'readwrite')

  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()

    const store = transaction.objectStore(STORES.SEARCH_INDEX)

    // 既存のインデックスをクリア
    store.clear()

    // 新しいインデックスを保存
    for (const [word, trackIds] of wordMap) {
      store.put({
        word,
        trackIds: Array.from(trackIds),
      })
    }
  })
}

/**
 * 単語を抽出
 */
function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2)
}

/**
 * 全文検索
 */
export async function searchTracks(query: string): Promise<LocalTrack[]> {
  const words = extractWords(query)
  if (words.length === 0) return []

  const db = await getDB()
  const transaction = db.transaction(STORES.SEARCH_INDEX, 'readonly')

  // 各単語のトラックIDセットを取得
  const trackIdSets: Set<string>[] = await Promise.all(
    words.map((word) => {
      return new Promise<Set<string>>((resolve, reject) => {
        const store = transaction.objectStore(STORES.SEARCH_INDEX)
        const request = store.get(word)

        request.onsuccess = () => {
          const result = request.result
          resolve(new Set(result?.trackIds || []))
        }
        request.onerror = () => reject(request.error)
      })
    }),
  )

  // 共通部分を取得（AND検索）
  let resultIds: Set<string> | null = null
  for (const ids of trackIdSets) {
    if (resultIds === null) {
      resultIds = ids
    } else {
      resultIds = new Set([...resultIds].filter((id) => ids.has(id)))
    }
  }

  if (!resultIds || resultIds.size === 0) return []

  // トラックを取得
  const tracksTransaction = db.transaction(STORES.TRACKS, 'readonly')
  const tracks: LocalTrack[] = []

  return new Promise((resolve, reject) => {
    const store = tracksTransaction.objectStore(STORES.TRACKS)

    for (const id of resultIds) {
      const request = store.get(id)
      request.onsuccess = () => {
        if (request.result) {
          tracks.push(request.result)
        }
      }
      request.onerror = () => reject(request.error)
    }

    tracksTransaction.oncomplete = () => resolve(tracks)
  })
}

/**
 * 変更検知: ファイルパス一覧を取得
 */
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

/**
 * ライブラリ統計を取得
 */
export async function getLibraryStats(): Promise<{
  totalTracks: number
  totalArtists: number
  totalAlbums: number
  totalDuration: number
}> {
  const tracks = await getAllTracks()

  const artists = new Set(tracks.map((t) => t.artist))
  const albums = new Set(tracks.map((t) => `${t.album}-${t.artist}`))
  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)

  return {
    totalTracks: tracks.length,
    totalArtists: artists.size,
    totalAlbums: albums.size,
    totalDuration,
  }
}

/**
 * 最終スキャン日時を取得
 */
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

/**
 * 最終スキャン日時を設定
 */
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
