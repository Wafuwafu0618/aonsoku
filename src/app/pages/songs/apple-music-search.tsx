import { Loader2, Play, Search } from 'lucide-react'
import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import { useSearchAppleMusic } from '@/app/hooks/use-apple-music'
import {
  mapAppleMusicSongToAppSong,
  mapAppleMusicSongsToAppSongs,
  resolveAppleMusicAlbumDetailId,
} from '@/domain/mappers/apple-music'
import { ROUTES } from '@/routes/routesList'
import { usePlayerActions } from '@/store/player.store'
import {
  AppleMusicAlbum,
  AppleMusicPlaylist,
  AppleMusicSong,
} from '@/types/responses/apple-music'

const SEARCH_TYPES = ['songs', 'albums', 'playlists']
const SUGGESTED_QUERIES = ['J-Pop', 'City Pop', 'Lo-fi', 'Jazz', 'Anime']

type SearchScope = 'all' | 'songs' | 'albums' | 'playlists'

export function AppleMusicCatalogSearch() {
  const { setSongList } = usePlayerActions()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryFromParams = (searchParams.get('query') || '').trim()
  const [query, setQuery] = useState(queryFromParams)
  const [submittedQuery, setSubmittedQuery] = useState(queryFromParams)
  const [scope, setScope] = useState<SearchScope>('all')

  useEffect(() => {
    setQuery(queryFromParams)
    setSubmittedQuery(queryFromParams)
  }, [queryFromParams])

  const { data, isLoading, isFetching, isError, error } = useSearchAppleMusic(
    submittedQuery,
    SEARCH_TYPES,
    submittedQuery.length > 0,
  )

  const songs = data?.songs ?? []
  const albums = data?.albums ?? []
  const playlists = data?.playlists ?? []

  const hasAnyResults =
    songs.length > 0 || albums.length > 0 || playlists.length > 0

  const visibleSongs = useMemo(() => {
    if (scope === 'songs') return songs
    if (scope === 'all') return songs.slice(0, 8)
    return []
  }, [scope, songs])

  const visibleAlbums = useMemo(() => {
    if (scope === 'albums') return albums
    if (scope === 'all') return albums.slice(0, 8)
    return []
  }, [scope, albums])

  const visiblePlaylists = useMemo(() => {
    if (scope === 'playlists') return playlists
    if (scope === 'all') return playlists.slice(0, 8)
    return []
  }, [scope, playlists])

  function updateQueryParam(nextQuery: string) {
    const nextParams = new URLSearchParams(searchParams)
    if (nextQuery.length > 0) {
      nextParams.set('query', nextQuery)
      nextParams.set('filter', 'search')
    } else {
      nextParams.delete('query')
    }
    setSearchParams(nextParams)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = query.trim()
    setSubmittedQuery(normalized)
    updateQueryParam(normalized)
  }

  function handleQuickSearch(nextQuery: string) {
    setQuery(nextQuery)
    setSubmittedQuery(nextQuery)
    updateQueryParam(nextQuery)
  }

  function playSong(song: AppleMusicSong) {
    setSongList([mapAppleMusicSongToAppSong(song)], 0)
  }

  function playAlbum(album: AppleMusicAlbum) {
    if (!album.songs || album.songs.length === 0) return
    setSongList(mapAppleMusicSongsToAppSongs(album.songs), 0)
  }

  function playPlaylist(playlist: AppleMusicPlaylist) {
    if (!playlist.songs || playlist.songs.length === 0) return
    setSongList(mapAppleMusicSongsToAppSongs(playlist.songs), 0)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-8 py-8 space-y-6">
        <section className="rounded-2xl border bg-background p-6">
          <h1 className="text-3xl font-semibold">検索</h1>

          <form onSubmit={handleSubmit} className="mt-5 flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="曲名、アーティスト、アルバム名で検索"
              className="h-11"
            />
            <Button type="submit" className="h-11 px-5">
              {isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap gap-2">
            {SUGGESTED_QUERIES.map((item) => (
              <button
                key={item}
                type="button"
                className="rounded-full border bg-muted px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => handleQuickSearch(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </section>

        <section className="flex flex-wrap gap-2">
          {[
            { id: 'all', label: 'すべて' },
            { id: 'songs', label: '曲' },
            { id: 'albums', label: 'アルバム' },
            { id: 'playlists', label: 'プレイリスト' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                scope === item.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setScope(item.id as SearchScope)}
            >
              {item.label}
            </button>
          ))}
        </section>

        {submittedQuery.length === 0 ? (
          <EmptyQueryState />
        ) : null}

        {submittedQuery.length > 0 && isLoading ? <LoadingState /> : null}

        {submittedQuery.length > 0 && isError ? (
          <div className="rounded-xl border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-200">
            検索に失敗しました: {error instanceof Error ? error.message : String(error)}
          </div>
        ) : null}

        {submittedQuery.length > 0 && !isLoading && !isError && !hasAnyResults ? (
          <div className="rounded-xl border border-white/10 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            「{submittedQuery}」に一致する結果が見つかりませんでした。
          </div>
        ) : null}

        {submittedQuery.length > 0 && !isLoading && hasAnyResults ? (
          <div className="space-y-8 pb-8">
            {visibleSongs.length > 0 && (
              <section className="space-y-3">
                <SectionHeader title="曲" count={songs.length} />
                <div className="space-y-2">
                  {visibleSongs.map((song) => (
                    <SongRow key={`${song.id}-${song.adamId}`} song={song} onPlay={playSong} />
                  ))}
                </div>
              </section>
            )}

            {visibleAlbums.length > 0 && (
              <section className="space-y-3">
                <SectionHeader title="アルバム" count={albums.length} />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {visibleAlbums.map((album) => (
                    <AlbumCard key={album.id} album={album} onPlay={playAlbum} />
                  ))}
                </div>
              </section>
            )}

            {visiblePlaylists.length > 0 && (
              <section className="space-y-3">
                <SectionHeader title="プレイリスト" count={playlists.length} />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {visiblePlaylists.map((playlist) => (
                    <PlaylistCard
                      key={playlist.id}
                      playlist={playlist}
                      onPlay={playPlaylist}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{count} 件</p>
    </div>
  )
}

function SongRow({
  song,
  onPlay,
}: {
  song: AppleMusicSong
  onPlay: (song: AppleMusicSong) => void
}) {
  return (
    <div className="group flex items-center gap-3 rounded-xl border border-white/10 bg-background/40 px-3 py-2">
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-skeleton">
        {song.artworkUrl ? (
          <img
            src={song.artworkUrl}
            alt={song.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full bg-skeleton" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{song.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {song.artistName} • {song.albumName}
        </p>
      </div>

      <span className="text-xs text-muted-foreground">
        {formatDuration(song.durationMs)}
      </span>

      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-9 w-9 rounded-full border-white/25 bg-background/65 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => onPlay(song)}
        aria-label={`Play ${song.title}`}
      >
        <Play className="h-4 w-4 fill-current" />
      </Button>
    </div>
  )
}

function AlbumCard({
  album,
  onPlay,
}: {
  album: AppleMusicAlbum
  onPlay: (album: AppleMusicAlbum) => void
}) {
  return (
    <div className="group overflow-hidden rounded-xl border border-white/10 bg-background/30">
      <Link to={ROUTES.APPLE_MUSIC_ALBUM.PAGE(resolveAppleMusicAlbumDetailId(album))}>
        <div className="aspect-square overflow-hidden bg-skeleton">
          {album.artworkUrl ? (
            <img
              src={album.artworkUrl}
              alt={album.name}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="h-full w-full bg-skeleton" />
          )}
        </div>
      </Link>
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{album.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {album.artistName}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0 rounded-full"
          onClick={() => onPlay(album)}
          disabled={!album.songs || album.songs.length === 0}
          aria-label={`Play ${album.name}`}
        >
          <Play className="h-4 w-4 fill-current" />
        </Button>
      </div>
    </div>
  )
}

function PlaylistCard({
  playlist,
  onPlay,
}: {
  playlist: AppleMusicPlaylist
  onPlay: (playlist: AppleMusicPlaylist) => void
}) {
  return (
    <div className="group overflow-hidden rounded-xl border border-white/10 bg-background/30">
      <div className="aspect-square overflow-hidden bg-skeleton">
        {playlist.artworkUrl ? (
          <img
            src={playlist.artworkUrl}
            alt={playlist.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="h-full w-full bg-skeleton" />
        )}
      </div>
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{playlist.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {playlist.curatorName || 'Apple Music'}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0 rounded-full"
          onClick={() => onPlay(playlist)}
          disabled={!playlist.songs || playlist.songs.length === 0}
          aria-label={`Play ${playlist.name}`}
        >
          <Play className="h-4 w-4 fill-current" />
        </Button>
      </div>
    </div>
  )
}

function EmptyQueryState() {
  return (
    <div className="rounded-xl border border-white/10 bg-muted/20 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        検索ワードを入力して、Apple Musicカタログ全体から曲を探してください。
      </p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-5 w-24 rounded bg-skeleton" />
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={`song-skeleton-${index}`} className="h-16 rounded-xl bg-skeleton" />
        ))}
      </div>
      <div className="space-y-2">
        <div className="h-5 w-24 rounded bg-skeleton" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={`album-skeleton-${index}`} className="aspect-[0.92] rounded-xl bg-skeleton" />
          ))}
        </div>
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
