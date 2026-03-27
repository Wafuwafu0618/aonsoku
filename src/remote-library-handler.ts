import { getSimpleCoverArtUrl } from '@/api/httpClient'
import { subsonic } from '@/service/subsonic'
import { RemoteLibraryRequest } from '../../electron/preload/types'

let remoteLibraryInitialized = false

/**
 * Remote Web Library API ハンドラー
 * Mainプロセスからのリクエストを受信してNavidrome APIを呼び出す
 */
export function initializeRemoteLibraryHandler() {
  if (remoteLibraryInitialized) {
    console.log('[RemoteLibrary] Handler already initialized')
    return
  }

  console.log('[RemoteLibrary] Initializing handler...')

  if (!window.api) {
    console.error('[RemoteLibrary] window.api not available')
    return
  }

  // Mainプロセスからのリクエストをリッスン
  window.api.remoteLibraryRequestListener(
    async (request: RemoteLibraryRequest) => {
      console.log('[RemoteLibrary] Received request:', request)

      const { requestId, channel, data } = request
      let result: unknown

      try {
        switch (channel) {
          case 'get-artists':
            result = await handleGetArtists(
              data as { limit?: number; offset?: number },
            )
            break

          case 'get-genres':
            result = await handleGetGenres(data as { limit?: number })
            break

          case 'get-albums':
            result = await handleGetAlbums(
              data as {
                artistId?: string
                genre?: string
                type?: string
                limit?: number
                offset?: number
              },
            )
            break

          case 'get-songs':
            result = await handleGetSongs(
              data as { albumId?: string; limit?: number; offset?: number },
            )
            break

          case 'search':
            result = await handleSearch(data as { query: string })
            break

          case 'get-cover-art':
            result = await handleGetCoverArt(data as { coverArtId: string })
            break

          default:
            console.warn('[RemoteLibrary] Unknown channel:', channel)
            result = null
        }
      } catch (error) {
        console.error('[RemoteLibrary] Error handling request:', error)
        result = null
      }

      // Mainプロセスにレスポンスを送信
      console.log('[RemoteLibrary] Sending response for request:', requestId)
      window.api?.sendRemoteLibraryResponse({
        requestId,
        data: result,
      })
    },
  )

  remoteLibraryInitialized = true
  console.log('[RemoteLibrary] Handler initialized')
}

async function handleGetArtists({
  limit,
  offset,
}: {
  limit?: number
  offset?: number
}) {
  try {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit ?? 50)))
    const safeOffset = Math.max(0, Math.trunc(offset ?? 0))

    // search3 の artistCount/artistOffset でページング取得
    const paged = await subsonic.search.get({
      query: '',
      artistCount: safeLimit,
      artistOffset: safeOffset,
      albumCount: 0,
      songCount: 0,
    })

    const artists = paged?.artist ?? []
    if (artists.length > 0 || safeOffset > 0) {
      return artists.map(
        (artist: { id: string; name: string; albumCount?: number }) => ({
          id: artist.id,
          name: artist.name,
          albumCount: artist.albumCount || 0,
        }),
      )
    }

    // サーバ差異で空になる場合のフォールバック
    const response = await subsonic.artists.getAll()
    return response
      .slice(safeOffset, safeOffset + safeLimit)
      .map((artist: { id: string; name: string; albumCount: number }) => ({
        id: artist.id,
        name: artist.name,
        albumCount: artist.albumCount || 0,
      }))
  } catch (error) {
    console.error('[RemoteLibrary] Failed to get artists:', error)
    return []
  }
}

async function handleGetGenres({ limit }: { limit?: number }) {
  try {
    const safeLimit = Math.min(30, Math.max(1, Math.trunc(limit ?? 6)))
    const genres = await subsonic.genres.get()
    if (!genres) return []

    return [...genres]
      .filter(
        (genre: { value: string; albumCount: number }) =>
          genre.value.trim().length > 0 && genre.albumCount > 0,
      )
      .sort(
        (
          a: { albumCount: number; value: string },
          b: { albumCount: number; value: string },
        ) => b.albumCount - a.albumCount || a.value.localeCompare(b.value),
      )
      .slice(0, safeLimit)
      .map(
        (genre: { value: string; albumCount: number; songCount: number }) => ({
          value: genre.value,
          albumCount: genre.albumCount,
          songCount: genre.songCount,
        }),
      )
  } catch (error) {
    console.error('[RemoteLibrary] Failed to get genres:', error)
    return []
  }
}

async function handleGetAlbums({
  artistId,
  genre,
  type,
  limit,
  offset,
}: {
  artistId?: string
  genre?: string
  type?: string
  limit?: number
  offset?: number
}) {
  try {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit ?? 50)))
    const safeOffset = Math.max(0, Math.trunc(offset ?? 0))

    if (artistId) {
      // 特定のアーティストのアルバムを取得
      const artist = await subsonic.artists.getOne(artistId)
      const albums = artist?.album ?? []
      return albums
        .slice(safeOffset, safeOffset + safeLimit)
        .map(
          (album: {
            id: string
            name: string
            year?: number
            coverArt?: string
          }) => ({
            id: album.id,
            name: album.name,
            artist: artist?.name ?? 'Unknown Artist',
            year: album.year,
            coverArt: album.coverArt,
          }),
        )
    } else {
      const normalizedGenre = genre?.trim() ?? ''
      const normalizedType = type?.trim() ?? ''
      const albumListType =
        normalizedType.length > 0
          ? normalizedType
          : normalizedGenre.length > 0
            ? 'byGenre'
            : 'alphabeticalByName'

      const response = await subsonic.albums.getAlbumList({
        type: albumListType as
          | 'random'
          | 'newest'
          | 'highest'
          | 'frequent'
          | 'recent'
          | 'alphabeticalByName'
          | 'alphabeticalByArtist'
          | 'starred'
          | 'byYear'
          | 'byGenre',
        size: safeLimit,
        offset: safeOffset,
        genre: normalizedGenre.length > 0 ? normalizedGenre : undefined,
      })
      const batch = response?.list ?? []
      return batch.map(
        (album: {
          id: string
          name: string
          artist?: string
          displayArtist?: string
          year?: number
          coverArt?: string
        }) => ({
          id: album.id,
          name: album.name,
          artist: album.artist || album.displayArtist || 'Unknown Artist',
          year: album.year,
          coverArt: album.coverArt,
        }),
      )
    }
  } catch (error) {
    console.error('[RemoteLibrary] Failed to get albums:', error)
    return []
  }
}

async function handleGetSongs({
  albumId,
  limit,
  offset,
}: {
  albumId?: string
  limit?: number
  offset?: number
}) {
  try {
    if (albumId) {
      // 特定のアルバムの曲を取得
      const album = await subsonic.albums.getOne(albumId)
      return (
        album?.song?.map(
          (song: {
            id: string
            title: string
            artist: string
            duration: number
            track?: number
            coverArt?: string
          }) => ({
            id: song.id,
            title: song.title,
            artist: song.artist,
            album: album.name,
            duration: song.duration,
            track: song.track,
            coverArt: song.coverArt,
          }),
        ) || []
      )
    } else {
      // 曲タブ初期表示は上限付きで取得（全件取得を避ける）
      const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit ?? 50)))
      const safeOffset = Math.max(0, Math.trunc(offset ?? 0))
      const response = await subsonic.songs.getAllSongs(safeLimit, safeOffset)
      return (
        response?.map(
          (song: {
            id: string
            title: string
            artist: string
            album: string
            duration: number
            track?: number
            coverArt?: string
          }) => ({
            id: song.id,
            title: song.title,
            artist: song.artist,
            album: song.album,
            duration: song.duration,
            track: song.track,
            coverArt: song.coverArt,
          }),
        ) || []
      )
    }
  } catch (error) {
    console.error('[RemoteLibrary] Failed to get songs:', error)
    return []
  }
}

async function handleSearch({ query }: { query: string }) {
  try {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      return { artists: [], albums: [], songs: [] }
    }

    const response = await subsonic.search.get({
      query: normalizedQuery,
      songCount: 20,
      albumCount: 20,
      artistCount: 20,
    })

    return {
      artists:
        response?.artist?.map((artist: { id: string; name: string }) => ({
          id: artist.id,
          name: artist.name,
          albumCount: 0, // 検索結果では不明
        })) || [],
      albums:
        response?.album?.map(
          (album: {
            id: string
            name: string
            artist: string
            year?: number
            coverArt?: string
          }) => ({
            id: album.id,
            name: album.name,
            artist: album.artist,
            year: album.year,
            coverArt: album.coverArt,
          }),
        ) || [],
      songs:
        response?.song?.map(
          (song: {
            id: string
            title: string
            artist: string
            album: string
            duration: number
            coverArt?: string
          }) => ({
            id: song.id,
            title: song.title,
            artist: song.artist,
            album: song.album,
            duration: song.duration,
            coverArt: song.coverArt,
          }),
        ) || [],
    }
  } catch (error) {
    console.error('[RemoteLibrary] Failed to search:', error)
    return { artists: [], albums: [], songs: [] }
  }
}

async function handleGetCoverArt({ coverArtId }: { coverArtId: string }) {
  try {
    // 既存デスクトップ本体と同じURL生成を使う（認証・バージョン差異を吸収）
    // 実体取得はMain側で行い、RendererのCORS制約を回避する。
    const coverUrl = getSimpleCoverArtUrl(coverArtId, 'album', '600')
    if (!coverUrl || coverUrl.trim().length === 0) return null
    return { url: coverUrl }
  } catch (error) {
    console.error('[RemoteLibrary] Failed to get cover art:', error)
    return null
  }
}
