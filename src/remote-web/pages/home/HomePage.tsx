import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import * as remoteApi from '../../lib/remoteApi'

const HOME_GENRE_COUNT = 8
const HOME_QUICK_ALBUM_COUNT = 8
const HOME_NEW_SONG_COUNT = 12
const HOME_EXPLORE_PAGE_SIZE = 6
const HOME_SECTION_ALBUM_COUNT = 10
const HOME_MIX_COUNT = 4

type FeatureKey = 'jpop' | 'anime' | 'imas'

interface FeatureTarget {
  key: FeatureKey
  title: string
  genre?: string
}

interface HomePageProps {
  leaseId?: string
  onAlbumSelect?: (album: remoteApi.NavidromeAlbum) => void
}

export function HomePage({ leaseId, onAlbumSelect }: HomePageProps) {
  const { data: genres, isLoading: genresLoading } = useQuery({
    queryKey: ['home', 'genres', leaseId],
    queryFn: ({ signal }) =>
      leaseId
        ? remoteApi.getGenres(leaseId, HOME_GENRE_COUNT, signal)
        : Promise.resolve([]),
    enabled: !!leaseId,
    retry: false,
    staleTime: 10 * 60 * 1000,
  })

  const topGenres = useMemo(
    () =>
      (genres ?? [])
        .filter((genre) => genre.value.trim().length > 0 && genre.albumCount > 0)
        .slice(0, HOME_GENRE_COUNT),
    [genres],
  )

  const genreAlbumQueries = useQueries({
    queries: topGenres.map((genre) => ({
      queryKey: ['home', 'genre-albums', leaseId, genre.value],
      queryFn: ({ signal }) =>
        leaseId
          ? remoteApi.getAlbumsByGenre(
              leaseId,
              genre.value,
              HOME_QUICK_ALBUM_COUNT,
              signal,
            )
          : Promise.resolve([]),
      enabled: !!leaseId,
      retry: false,
      staleTime: 10 * 60 * 1000,
    })),
  })

  const compactAlbums = useMemo(() => {
    const raw = topGenres.flatMap(
      (_, index) => genreAlbumQueries[index]?.data ?? [],
    )
    const unique = raw.filter(
      (album, index) => raw.findIndex((item) => item.id === album.id) === index,
    )
    return unique.slice(0, HOME_QUICK_ALBUM_COUNT)
  }, [topGenres, genreAlbumQueries])

  const compactCardsLoading =
    genresLoading ||
    (topGenres.length > 0 &&
      genreAlbumQueries.some((query) => query.isLoading && !query.data))

  const { data: recentAlbums, isLoading: recentAlbumsLoading } = useQuery({
    queryKey: ['home', 'recent-albums', leaseId],
    queryFn: ({ signal }) =>
      leaseId
        ? remoteApi.getAlbums(leaseId, {
            type: 'recent',
            limit: HOME_QUICK_ALBUM_COUNT,
            offset: 0,
            signal,
          })
        : Promise.resolve([]),
    enabled: !!leaseId,
    retry: false,
    staleTime: 3 * 60 * 1000,
  })

  const headerRecentAlbums = useMemo(() => {
    if (recentAlbums && recentAlbums.length > 0) {
      return recentAlbums.slice(0, HOME_QUICK_ALBUM_COUNT)
    }
    return compactAlbums
  }, [recentAlbums, compactAlbums])

  const headerCardsLoading = recentAlbumsLoading || compactCardsLoading

  const { data: latestSongs, isLoading: latestSongsLoading } = useQuery({
    queryKey: ['home', 'latest-songs', leaseId],
    queryFn: ({ signal }) =>
      leaseId
        ? remoteApi.getSongs(leaseId, undefined, HOME_NEW_SONG_COUNT, 0, signal)
        : Promise.resolve([]),
    enabled: !!leaseId,
    retry: false,
    staleTime: 60 * 1000,
  })

  const explorePages = useMemo(() => {
    const songs = latestSongs ?? []
    const pages: remoteApi.NavidromeSong[][] = []
    for (let i = 0; i < songs.length; i += HOME_EXPLORE_PAGE_SIZE) {
      pages.push(songs.slice(i, i + HOME_EXPLORE_PAGE_SIZE))
    }
    return pages
  }, [latestSongs])

  const featureTargets = useMemo<FeatureTarget[]>(() => {
    const available = (genres ?? [])
      .map((genre) => genre.value.trim())
      .filter((value) => value.length > 0)

    const used = new Set<string>()
    const pick = (matcher: RegExp): string | undefined => {
      const matched = available.find(
        (value) => !used.has(value) && matcher.test(value),
      )
      if (matched) {
        used.add(matched)
        return matched
      }

      const fallback = available.find((value) => !used.has(value))
      if (fallback) {
        used.add(fallback)
        return fallback
      }
      return undefined
    }

    return [
      {
        key: 'jpop',
        title: 'J-POP特集',
        genre: pick(/j[\s-]*pop|jpop/i),
      },
      {
        key: 'anime',
        title: 'Anime特集',
        genre: pick(/anime|アニメ/i),
      },
      {
        key: 'imas',
        title: 'iM@s特集',
        genre: pick(/iM@?s|idolm@ster|アイマス/i),
      },
    ]
  }, [genres])

  const featureAlbumQueries = useQueries({
    queries: featureTargets.map((target) => ({
      queryKey: ['home', 'feature-albums', leaseId, target.key, target.genre],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        leaseId && target.genre
          ? remoteApi.getAlbumsByGenre(
              leaseId,
              target.genre,
              HOME_SECTION_ALBUM_COUNT,
              signal,
            )
          : Promise.resolve([]),
      enabled: !!leaseId && !!target.genre,
      retry: false,
      staleTime: 10 * 60 * 1000,
    })),
  })

  const featureSections = featureTargets.map((target, index) => ({
    ...target,
    albums: featureAlbumQueries[index]?.data ?? [],
    isLoading: featureAlbumQueries[index]?.isLoading ?? false,
  }))

  const mixAlbums = useMemo(() => {
    const source = [
      ...featureSections.flatMap((section) => section.albums),
      ...compactAlbums,
    ]
    const unique = source.filter(
      (album, index) =>
        source.findIndex((candidate) => candidate.id === album.id) === index,
    )
    return unique.slice(0, HOME_MIX_COUNT)
  }, [featureSections, compactAlbums])

  if (!leaseId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        セッション確立後にホーム情報を読み込みます
      </div>
    )
  }

  if (genresLoading) {
    return <HomeSkeleton />
  }

  if (topGenres.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        ホームに表示できるジャンルが見つかりません
      </div>
    )
  }

  return (
    <div className="home-v2 p-4 space-y-8">
      <section className="space-y-3">
        <div className="home-quick-grid">
          {headerCardsLoading
            ? Array.from({ length: HOME_QUICK_ALBUM_COUNT }).map((_, index) => (
                <div key={`quick-skeleton-${index}`} className="home-quick-card">
                  <div className="home-quick-cover animate-pulse bg-muted" />
                  <div className="h-4 rounded bg-muted animate-pulse w-2/3" />
                </div>
              ))
              : headerRecentAlbums.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  className="home-quick-card text-left"
                  onClick={() => onAlbumSelect?.(album)}
                >
                  <div className="home-quick-cover bg-muted">
                    {album.coverArt ? (
                      <img
                        src={`/api/remote/cover?leaseId=${encodeURIComponent(leaseId)}&id=${encodeURIComponent(album.coverArt)}`}
                        alt={album.name}
                        className="home-quick-cover-img"
                        loading="lazy"
                      />
                    ) : (
                      <span className="text-[11px] text-muted-foreground">NO</span>
                    )}
                  </div>
                  <p className="home-quick-title media-title truncate">
                    {album.name}
                  </p>
                </button>
              ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="home-section-title">探索</h2>
        <div className="home-song-scroller hide-scrollbar">
          {latestSongsLoading ? (
            Array.from({ length: 2 }).map((_, pageIndex) => (
              <div
                key={`song-skeleton-page-${pageIndex}`}
                className="home-song-page"
              >
                {Array.from({ length: HOME_EXPLORE_PAGE_SIZE }).map((_, index) => (
                  <div
                    key={`song-skeleton-${pageIndex}-${index}`}
                    className="home-song-item"
                  >
                    <div className="home-song-cover animate-pulse bg-muted" />
                    <div className="home-song-meta">
                      <div className="h-5 rounded bg-muted animate-pulse w-3/4" />
                      <div className="h-4 rounded bg-muted animate-pulse w-1/2" />
                      <div className="h-[3px] rounded bg-muted animate-pulse w-full mt-1.5" />
                    </div>
                  </div>
                ))}
              </div>
            ))
          ) : (
            explorePages.map((pageSongs, pageIndex) => (
              <div key={`explore-page-${pageIndex}`} className="home-song-page">
                {pageSongs.map((song) => (
                  <article key={`${song.id}-${pageIndex}`} className="home-song-item">
                    <div className="home-song-cover bg-muted">
                      {song.coverArt ? (
                        <img
                          src={`/api/remote/cover?leaseId=${encodeURIComponent(leaseId)}&id=${encodeURIComponent(song.coverArt)}`}
                          alt={song.title}
                          className="home-song-cover-img"
                          loading="lazy"
                        />
                      ) : null}
                    </div>
                    <div className="home-song-meta">
                      <p className="home-song-title media-title truncate">
                        {song.title}
                      </p>
                      <p className="home-song-subtitle media-subtitle truncate">
                        {song.artist}
                      </p>
                      <div className="home-song-divider" />
                    </div>
                  </article>
                ))}
              </div>
            ))
          )}
        </div>
      </section>

      {featureSections.map((section) => (
        <section key={section.key} className="space-y-3">
          <h2 className="home-section-title">{section.title}</h2>
          <div className="home-feature-row hide-scrollbar">
            {section.isLoading
              ? Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={`${section.key}-skeleton-${index}`}
                    className="home-feature-card"
                  >
                    <div className="home-feature-art animate-pulse bg-muted" />
                  </div>
                ))
              : section.albums.map((album) => (
                  <button
                    key={album.id}
                    type="button"
                    className="home-feature-card text-left"
                    onClick={() => onAlbumSelect?.(album)}
                  >
                    <div className="home-feature-art bg-muted">
                      {album.coverArt ? (
                        <img
                          src={`/api/remote/cover?leaseId=${encodeURIComponent(leaseId)}&id=${encodeURIComponent(album.coverArt)}`}
                          alt={album.name}
                          className="home-feature-img"
                          loading="lazy"
                        />
                      ) : null}
                    </div>
                    <div className="home-feature-meta">
                      <p className="home-feature-title media-title truncate">
                        {album.name}
                      </p>
                      <p className="home-feature-subtitle media-subtitle truncate">
                        {album.artist}
                      </p>
                    </div>
                  </button>
                ))}
          </div>
        </section>
      ))}

      <section className="space-y-3">
        <h2 className="home-section-title">あなた向けミックス</h2>
        <div className="home-mix-grid">
          {mixAlbums.map((album) => (
            <button
              key={album.id}
              type="button"
              className="home-mix-card text-left"
              onClick={() => onAlbumSelect?.(album)}
            >
              <div className="home-mix-art bg-muted">
                {album.coverArt ? (
                  <img
                    src={`/api/remote/cover?leaseId=${encodeURIComponent(leaseId)}&id=${encodeURIComponent(album.coverArt)}`}
                    alt={album.name}
                    className="home-feature-img"
                    loading="lazy"
                  />
                ) : null}
              </div>
              <div className="home-mix-chip">ARTIST MIX</div>
              <p className="home-mix-name media-title truncate">{album.artist} Mix</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function HomeSkeleton() {
  return (
    <div className="home-v2 p-4 space-y-8">
      <section className="space-y-3">
        <div className="home-quick-grid">
          {Array.from({ length: HOME_QUICK_ALBUM_COUNT }).map((_, index) => (
            <div key={`quick-skeleton-${index}`} className="home-quick-card">
              <div className="home-quick-cover animate-pulse bg-muted" />
              <div className="h-4 rounded bg-muted animate-pulse w-2/3" />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="h-9 w-40 rounded bg-muted animate-pulse" />
        <div className="home-song-scroller hide-scrollbar">
          {Array.from({ length: 2 }).map((_, pageIndex) => (
            <div key={`song-skeleton-page-${pageIndex}`} className="home-song-page">
              {Array.from({ length: HOME_EXPLORE_PAGE_SIZE }).map((_, index) => (
                <div key={`song-skeleton-${pageIndex}-${index}`} className="home-song-item">
                  <div className="home-song-cover animate-pulse bg-muted" />
                  <div className="home-song-meta">
                    <div className="h-5 rounded bg-muted animate-pulse w-3/4" />
                    <div className="h-4 rounded bg-muted animate-pulse w-1/2" />
                    <div className="h-[3px] rounded bg-muted animate-pulse w-full mt-1.5" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="h-9 w-40 rounded bg-muted animate-pulse" />
        <div className="home-feature-row hide-scrollbar">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={`feature-skeleton-${index}`} className="home-feature-card">
              <div className="home-feature-art animate-pulse bg-muted" />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
