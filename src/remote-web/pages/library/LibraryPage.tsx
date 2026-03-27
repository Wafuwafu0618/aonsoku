import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import * as remoteApi from '../../lib/remoteApi'

type TabType = 'artists' | 'albums' | 'songs'
const PAGE_SIZE = 50

interface LibraryPageProps {
  leaseId?: string
  onAlbumSelect?: (album: remoteApi.NavidromeAlbum) => void
}

export function LibraryPage({ leaseId, onAlbumSelect }: LibraryPageProps) {
  const [activeTab, setActiveTab] = useState<TabType>('artists')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, 300)

    return () => clearTimeout(timeout)
  }, [searchQuery])

  // アーティスト取得（ページング）
  const artistsQuery = useInfiniteQuery({
    queryKey: ['library', 'artists', leaseId],
    queryFn: ({ pageParam, signal }) =>
      leaseId
        ? remoteApi.getArtists(
            leaseId,
            PAGE_SIZE,
            Number(pageParam ?? 0),
            signal,
          )
        : Promise.resolve([]),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE,
    enabled:
      !!leaseId &&
      activeTab === 'artists' &&
      debouncedSearchQuery.length === 0,
    retry: false,
  })

  // アルバム取得（ページング）
  const albumsQuery = useInfiniteQuery({
    queryKey: ['library', 'albums', leaseId],
    queryFn: ({ pageParam, signal }) =>
      leaseId
        ? remoteApi.getAlbums(leaseId, {
            limit: PAGE_SIZE,
            offset: Number(pageParam ?? 0),
            signal,
          })
        : Promise.resolve([]),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE,
    enabled:
      !!leaseId &&
      activeTab === 'albums' &&
      debouncedSearchQuery.length === 0,
    retry: false,
  })

  // 曲取得（ページング）
  const songsQuery = useInfiniteQuery({
    queryKey: ['library', 'songs', leaseId],
    queryFn: ({ pageParam, signal }) =>
      leaseId
        ? remoteApi.getSongs(
            leaseId,
            undefined,
            PAGE_SIZE,
            Number(pageParam ?? 0),
            signal,
          )
        : Promise.resolve([]),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE,
    enabled:
      !!leaseId && activeTab === 'songs' && debouncedSearchQuery.length === 0,
    retry: false,
  })

  // 検索
  const { data: searchResults, isFetching: searchLoading } = useQuery({
    queryKey: ['library', 'search', leaseId, debouncedSearchQuery],
    queryFn: ({ signal }) =>
      leaseId && debouncedSearchQuery.length >= 2
        ? remoteApi.searchLibrary(leaseId, debouncedSearchQuery, signal)
        : Promise.resolve({ artists: [], albums: [], songs: [] }),
    enabled: !!leaseId && debouncedSearchQuery.length >= 2,
    retry: false,
  })

  const artists = useMemo(
    () => artistsQuery.data?.pages.flat() ?? [],
    [artistsQuery.data],
  )
  const albums = useMemo(
    () => albumsQuery.data?.pages.flat() ?? [],
    [albumsQuery.data],
  )
  const songs = useMemo(
    () => songsQuery.data?.pages.flat() ?? [],
    [songsQuery.data],
  )

  const isLoading =
    activeTab === 'artists'
      ? artistsQuery.isLoading
      : activeTab === 'albums'
        ? albumsQuery.isLoading
        : songsQuery.isLoading

  const activeHasNextPage =
    activeTab === 'artists'
      ? Boolean(artistsQuery.hasNextPage)
      : activeTab === 'albums'
        ? Boolean(albumsQuery.hasNextPage)
        : Boolean(songsQuery.hasNextPage)

  const activeIsFetchingNextPage =
    activeTab === 'artists'
      ? artistsQuery.isFetchingNextPage
      : activeTab === 'albums'
        ? albumsQuery.isFetchingNextPage
        : songsQuery.isFetchingNextPage

  const artistsHasNextPage = Boolean(artistsQuery.hasNextPage)
  const albumsHasNextPage = Boolean(albumsQuery.hasNextPage)
  const songsHasNextPage = Boolean(songsQuery.hasNextPage)

  useEffect(() => {
    if (debouncedSearchQuery.length >= 2) return
    if (!activeHasNextPage) return
    const sentinel = loadMoreRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries.some((entry) => entry.isIntersecting)
        if (!isIntersecting) return

        if (activeTab === 'artists') {
          if (!artistsHasNextPage || artistsQuery.isFetchingNextPage) return
          void artistsQuery.fetchNextPage()
          return
        }

        if (activeTab === 'albums') {
          if (!albumsHasNextPage || albumsQuery.isFetchingNextPage) return
          void albumsQuery.fetchNextPage()
          return
        }

        if (!songsHasNextPage || songsQuery.isFetchingNextPage) return
        void songsQuery.fetchNextPage()
      },
      {
        root: sentinel.parentElement,
        rootMargin: '240px 0px',
        threshold: 0,
      },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    debouncedSearchQuery,
    activeHasNextPage,
    activeTab,
    artistsHasNextPage,
    artistsQuery.fetchNextPage,
    artistsQuery.isFetchingNextPage,
    albumsHasNextPage,
    albumsQuery.fetchNextPage,
    albumsQuery.isFetchingNextPage,
    songsHasNextPage,
    songsQuery.fetchNextPage,
    songsQuery.isFetchingNextPage,
  ])

  return (
    <div className="flex flex-col h-full">
      {/* 検索バー */}
      <div className="p-4 border-b">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="検索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={cn(
              'w-full pl-10 pr-4 py-2.5 rounded-lg',
              'bg-muted text-sm',
              'focus:outline-none focus:ring-2 focus:ring-primary',
              'placeholder:text-muted-foreground',
            )}
          />
        </div>
      </div>

      {/* タブ */}
      <div className="flex border-b">
        {(['artists', 'albums', 'songs'] as TabType[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex-1 py-3 text-sm font-medium transition-colors relative',
              activeTab === tab
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab === 'artists' && 'アーティスト'}
            {tab === 'albums' && 'アルバム'}
            {tab === 'songs' && '曲'}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        ))}
      </div>

      {/* コンテンツ */}
      <div className="flex-1 overflow-auto p-4 hide-scrollbar">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : debouncedSearchQuery.length >= 2 && searchLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : debouncedSearchQuery.length >= 2 && searchResults ? (
          <SearchResults
            results={searchResults}
            leaseId={leaseId}
            onAlbumSelect={onAlbumSelect}
          />
        ) : (
          <>
            {activeTab === 'artists' && <ArtistsList artists={artists} />}
            {activeTab === 'albums' && (
              <AlbumsList
                albums={albums}
                leaseId={leaseId}
                onAlbumSelect={onAlbumSelect}
              />
            )}
            {activeTab === 'songs' && <SongsList songs={songs} />}

            {activeHasNextPage && (
              <div ref={loadMoreRef} className="py-4 flex justify-center">
                {activeIsFetchingNextPage ? (
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    スクロールでさらに読み込み
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ArtistsList({ artists }: { artists: remoteApi.NavidromeArtist[] }) {
  return (
    <div className="space-y-1">
      {artists.map((artist) => (
        <div
          key={artist.id}
          className="list-item cursor-pointer hover:bg-accent/50"
        >
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <span className="text-lg font-medium">{artist.name.charAt(0)}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="media-title truncate">{artist.name}</p>
            <p className="text-sm media-subtitle">
              {artist.albumCount} アルバム
            </p>
          </div>
        </div>
      ))}
      {artists.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          アーティストが見つかりません
        </p>
      )}
    </div>
  )
}

function AlbumsList({
  albums,
  leaseId,
  onAlbumSelect,
}: {
  albums: remoteApi.NavidromeAlbum[]
  leaseId?: string
  onAlbumSelect?: (album: remoteApi.NavidromeAlbum) => void
}) {
  return (
    <div className="library-grid">
      {albums.map((album) => (
        <button
          key={album.id}
          type="button"
          className="space-y-2 text-left"
          onClick={() => onAlbumSelect?.(album)}
        >
          <div className="album-art bg-muted flex items-center justify-center">
            {album.coverArt ? (
              <img
                src={`/api/remote/cover?leaseId=${encodeURIComponent(leaseId ?? '')}&id=${encodeURIComponent(album.coverArt)}`}
                alt={album.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <svg
                className="w-12 h-12 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                />
              </svg>
            )}
          </div>
          <div className="space-y-0.5">
            <p className="text-sm media-title truncate">{album.name}</p>
            <p className="text-xs media-subtitle truncate">
              {album.artist}
            </p>
            {album.year && (
              <p className="text-xs media-subtitle">{album.year}</p>
            )}
          </div>
        </button>
      ))}
      {albums.length === 0 && (
        <p className="text-center text-muted-foreground py-8 col-span-full">
          アルバムが見つかりません
        </p>
      )}
    </div>
  )
}

function SongsList({ songs }: { songs: remoteApi.NavidromeSong[] }) {
  return (
    <div className="space-y-1">
      {songs.map((song, index) => (
        <div
          key={song.id}
          className="list-item cursor-pointer hover:bg-accent/50"
        >
          <span className="w-6 text-center text-sm text-muted-foreground">
            {song.track || index + 1}
          </span>
          <div className="flex-1 min-w-0">
            <p className="media-title truncate">{song.title}</p>
            <p className="text-sm media-subtitle truncate">
              {song.artist}
            </p>
          </div>
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatDuration(song.duration)}
          </span>
        </div>
      ))}
      {songs.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          曲が見つかりません
        </p>
      )}
    </div>
  )
}

function SearchResults({
  results,
  leaseId,
  onAlbumSelect,
}: {
  results: {
    artists: remoteApi.NavidromeArtist[]
    albums: remoteApi.NavidromeAlbum[]
    songs: remoteApi.NavidromeSong[]
  }
  leaseId?: string
  onAlbumSelect?: (album: remoteApi.NavidromeAlbum) => void
}) {
  const hasResults =
    results.artists.length > 0 ||
    results.albums.length > 0 ||
    results.songs.length > 0

  if (!hasResults) {
    return (
      <p className="text-center text-muted-foreground py-8">
        検索結果が見つかりません
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {results.artists.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">
            アーティスト
          </h3>
          <ArtistsList artists={results.artists} />
        </section>
      )}
      {results.albums.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">
            アルバム
          </h3>
          <AlbumsList
            albums={results.albums}
            leaseId={leaseId}
            onAlbumSelect={onAlbumSelect}
          />
        </section>
      )}
      {results.songs.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">
            曲
          </h3>
          <SongsList songs={results.songs} />
        </section>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
