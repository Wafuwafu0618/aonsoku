import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Button } from '@/app/components/ui/button'
import { useGetCatalogAlbum } from '@/app/hooks/use-apple-music'
import { ROUTES } from '@/routes/routesList'
import { appleMusicService } from '@/service/apple-music'
import { usePlayerActions } from '@/store/player.store'
import {
  AppleMusicAlbum,
  AppleMusicBrowseResult,
  AppleMusicLibraryPageResult,
  AppleMusicSearchResult,
  AppleMusicSong,
} from '@/types/responses/apple-music'
import { queryKeys } from '@/utils/queryKeys'

export default function AppleMusicAlbumPage() {
  const { albumId } = useParams<{ albumId: string }>()
  const [searchParams] = useSearchParams()
  const genre = searchParams.get('genre')
  const { setSongList } = usePlayerActions()
  const queryClient = useQueryClient()

  console.log('[AppleMusicAlbumPage] albumId:', albumId)
  console.log('[AppleMusicAlbumPage] genre from URL:', genre)

  // まずカタログAPIを試す
  const {
    data: catalogAlbum,
    isLoading: isCatalogLoading,
    error: catalogError,
  } = useGetCatalogAlbum(albumId || '', !!albumId)

  console.log('[AppleMusicAlbumPage] catalogAlbum:', catalogAlbum)
  console.log('[AppleMusicAlbumPage] catalogError:', catalogError)

  function isMatchedAlbum(candidate: AppleMusicAlbum | undefined): boolean {
    if (!candidate || !albumId) return false
    return candidate.id === albumId || candidate.catalogId === albumId
  }

  // キャッシュからアルバムを探す（genre検索 → 全検索キャッシュ → ライブラリ → Browse）
  let cachedAlbum: AppleMusicAlbum | undefined

  if (!catalogAlbum) {
    const cacheKey = [queryKeys.appleMusic.search, genre, ['songs', 'albums']]
    if (genre) {
      console.log('[AppleMusicAlbumPage] Looking for cache with key:', cacheKey)

      const cachedSearchData = queryClient.getQueryData<AppleMusicSearchResult>(
        cacheKey,
      )

      console.log('[AppleMusicAlbumPage] cachedSearchData:', cachedSearchData)

      cachedAlbum = cachedSearchData?.albums?.find((a) => isMatchedAlbum(a))
    }

    if (!cachedAlbum) {
      const searchCaches = queryClient.getQueriesData<AppleMusicSearchResult>({
        queryKey: [queryKeys.appleMusic.search],
      })
      for (const [, data] of searchCaches) {
        const found = data?.albums?.find((a) => isMatchedAlbum(a))
        if (found) {
          cachedAlbum = found
          break
        }
      }
    }

    if (!cachedAlbum) {
      const libraryCaches =
        queryClient.getQueriesData<AppleMusicLibraryPageResult>({
          queryKey: [queryKeys.appleMusic.library],
        })
      for (const [, data] of libraryCaches) {
        const found = data?.albums?.find((a) => isMatchedAlbum(a))
        if (found) {
          cachedAlbum = found
          break
        }
      }
    }

    if (!cachedAlbum) {
      const browseCaches = queryClient.getQueriesData<AppleMusicBrowseResult>({
        queryKey: [queryKeys.appleMusic.browse],
      })
      for (const [, data] of browseCaches) {
        const fromTop = data?.topAlbums?.find((a) => isMatchedAlbum(a))
        if (fromTop) {
          cachedAlbum = fromTop
          break
        }
        const fromReleases = data?.newReleases?.find((a) => isMatchedAlbum(a))
        if (fromReleases) {
          cachedAlbum = fromReleases
          break
        }
      }
    }

    console.log('[AppleMusicAlbumPage] cachedAlbum:', cachedAlbum)
    console.log('[AppleMusicAlbumPage] cachedAlbum.songs:', cachedAlbum?.songs)
    console.log(
      '[AppleMusicAlbumPage] cachedAlbum.songs length:',
      cachedAlbum?.songs?.length,
    )
  }

  // 最終的に表示するアルバム
  // 優先順位: 1. カタログAPI（曲リストあり） 2. キャッシュ（曲リストあり） 3. カタログAPI（曲リストなし） 4. キャッシュ（曲リストなし）
  let album: AppleMusicAlbum | undefined
  let albumSource: 'catalog-with-songs' | 'cached-with-songs' | 'catalog' | 'cached' | 'none' =
    'none'

  if (catalogAlbum && catalogAlbum.songs && catalogAlbum.songs.length > 0) {
    // カタログAPIが成功し、曲リストもある
    album = catalogAlbum
    albumSource = 'catalog-with-songs'
    console.log('[AppleMusicAlbumPage] Using catalog album with songs')
  } else if (cachedAlbum && cachedAlbum.songs && cachedAlbum.songs.length > 0) {
    // キャッシュに曲リストがある
    album = cachedAlbum
    albumSource = 'cached-with-songs'
    console.log('[AppleMusicAlbumPage] Using cached album with songs')
  } else if (catalogAlbum) {
    // カタログAPIは成功したが曲リストがない
    album = catalogAlbum
    albumSource = 'catalog'
    console.log('[AppleMusicAlbumPage] Using catalog album without songs')
  } else if (cachedAlbum) {
    // キャッシュのみ利用可能
    album = cachedAlbum
    albumSource = 'cached'
    console.log('[AppleMusicAlbumPage] Using cached album without songs')
  }

  // どちらも見つからない場合はエラー
  const isLoading = isCatalogLoading && !cachedAlbum
  const error = !album && catalogError

  const baseAlbumId = album?.id ?? ''
  const baseAlbumName = album?.name ?? ''
  const baseArtistName = album?.artistName ?? ''
  const baseSongs = album?.songs ?? []
  const needsSongRecovery = Boolean(
    album &&
      baseSongs.length === 0 &&
      (albumSource === 'cached' || albumSource === 'catalog'),
  )

  const {
    data: recoveredSongs = [],
    isFetching: isRecoveringSongs,
  } = useQuery({
    queryKey: [
      queryKeys.appleMusic.album,
      'recover-songs',
      baseAlbumId,
      baseAlbumName,
      baseArtistName,
    ],
    enabled: needsSongRecovery && baseAlbumName.trim().length > 0,
    queryFn: async () => {
      const searchQuery = [baseArtistName, baseAlbumName]
        .filter((part) => part.trim().length > 0)
        .join(' ')
        .trim()

      if (searchQuery.length === 0) return [] as AppleMusicSong[]

      const fallbackSearch = await appleMusicService.search(searchQuery, ['songs'])
      const targetArtistName = normalizeLooseText(baseArtistName)
      const albumMatchedSongs = fallbackSearch.songs.filter((song) =>
        isAlbumNameMatch(baseAlbumName, song.albumName),
      )

      const strictMatchedSongs =
        targetArtistName.length === 0
          ? albumMatchedSongs
          : albumMatchedSongs.filter(
              (song) => normalizeLooseText(song.artistName) === targetArtistName,
            )

      return strictMatchedSongs.length > 0 ? strictMatchedSongs : albumMatchedSongs
    },
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const songs = baseSongs.length > 0 ? baseSongs : recoveredSongs

  if (isLoading) {
    return (
      <div className="w-full h-full px-8 py-6">
        <div className="flex gap-6">
          <div className="w-64 h-64 bg-skeleton rounded-lg" />
          <div className="flex-1">
            <div className="h-8 bg-skeleton rounded w-1/2 mb-4" />
            <div className="h-4 bg-skeleton rounded w-1/3" />
          </div>
        </div>
      </div>
    )
  }

  if (!album) {
    return (
      <div className="w-full h-full px-8 py-6">
        <Link
          to={ROUTES.LIBRARY.HOME}
          className="text-sm text-muted-foreground hover:text-primary mb-4 inline-block"
        >
          ← ホームに戻る
        </Link>
        <p className="text-muted-foreground">アルバムが見つかりませんでした</p>
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
            <p className="text-red-600 text-sm">Error: {error.message}</p>
            <p className="text-red-500 text-xs mt-2">AlbumId: {albumId}</p>
            <p className="text-red-500 text-xs mt-1">
              Genre: {genre || '未指定'}
            </p>
            <p className="text-red-500 text-xs mt-1">
              このアルバムはApple Musicカタログから取得できません。
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="w-full h-full px-8 py-6 overflow-auto">
      {/* 戻るリンク */}
      <Link
        to={ROUTES.LIBRARY.HOME}
        className="text-sm text-muted-foreground hover:text-primary mb-6 inline-block"
      >
        ← ホームに戻る
      </Link>

      {/* アルバムヘッダー */}
      <div className="flex gap-6 mb-8">
        <div className="w-64 h-64 shrink-0">
          {album.artworkUrl ? (
            <img
              src={album.artworkUrl}
              alt={album.name}
              className="w-full h-full object-cover rounded-lg shadow-lg"
            />
          ) : (
            <div className="w-full h-full bg-skeleton rounded-lg" />
          )}
        </div>

        <div className="flex-1 flex flex-col justify-end">
          <p className="text-sm text-muted-foreground mb-2">アルバム</p>
          <h1 className="text-4xl font-bold mb-4">{album.name}</h1>
          <p className="text-lg text-muted-foreground mb-6">
            {album.artistName} • {album.trackCount}曲
          </p>

          <Button
            size="lg"
            className="w-fit"
            onClick={() => {
              if (songs.length > 0) {
                setSongList(songs as any, 0)
              }
            }}
            disabled={songs.length === 0}
          >
            <Play className="w-5 h-5 mr-2" />
            再生
          </Button>
        </div>
      </div>

      {/* 曲リスト */}
      <div className="space-y-2">
        {songs.length > 0 ? (
          songs.map((song, index) => (
            <div
              key={song.id}
              className="flex items-center gap-4 p-3 rounded-lg hover:bg-muted/50 cursor-pointer group"
              onClick={() => setSongList(songs as any, index)}
            >
              <span className="w-8 text-center text-muted-foreground">
                {index + 1}
              </span>

              <div className="flex-1">
                <p className="font-medium">{song.title}</p>
                <p className="text-sm text-muted-foreground">
                  {song.artistName}
                </p>
              </div>

              <span className="text-sm text-muted-foreground">
                {formatDuration(song.durationMs)}
              </span>

              <Button
                size="icon"
                variant="ghost"
                className="opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  setSongList([song as any], 0)
                }}
              >
                <Play className="w-4 h-4" />
              </Button>
            </div>
          ))
        ) : isRecoveringSongs ? (
          <div className="text-center py-8 text-muted-foreground">
            <p className="text-sm mt-2">曲情報を読み込み中...</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function normalizeLooseText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isAlbumNameMatch(target: string, candidate: string): boolean {
  const normalizedTarget = normalizeLooseText(target)
  const normalizedCandidate = normalizeLooseText(candidate)
  if (!normalizedTarget || !normalizedCandidate) return false
  if (normalizedTarget === normalizedCandidate) return true
  return (
    normalizedCandidate.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedCandidate)
  )
}
