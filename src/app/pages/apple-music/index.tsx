import { Loader2, Music2, Play, Search } from 'lucide-react'
import { FormEvent, useMemo, useState } from 'react'
import { toast } from 'react-toastify'
import {
  mapAppleMusicSongToAppSong,
  mapAppleMusicSongToMediaTrack,
  resolveAppleMusicAlbumDetailId,
  resolveAppleMusicArtworkUrl,
} from '@/domain/mappers/apple-music'
import { MediaTrack } from '@/domain/entities/track'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import { appleMusicService } from '@/service/apple-music'
import {
  AppleMusicAlbum,
  AppleMusicBrowseResult,
  AppleMusicLibraryResult,
  AppleMusicPlaylist,
  AppleMusicSearchResult,
  AppleMusicSong,
} from '@/types/responses/apple-music'
import { usePlayerActions } from '@/store/player.store'

const EMPTY_LIBRARY_RESULT: AppleMusicLibraryResult = {
  songs: [],
  albums: [],
  playlists: [],
}

const EMPTY_BROWSE_RESULT: AppleMusicBrowseResult = {
  newReleases: [],
  topSongs: [],
  topAlbums: [],
  topPlaylists: [],
}

function appendUniqueById<T extends { id: string }>(current: T[], next: T[]): T[] {
  if (next.length === 0) return current

  const existing = new Set(current.map((entry) => entry.id))
  const merged = [...current]

  for (const entry of next) {
    if (existing.has(entry.id)) continue
    merged.push(entry)
    existing.add(entry.id)
  }

  return merged
}

function keepPreviousWhenEmpty<T>(current: T[], next: T[]): T[] {
  return next.length > 0 ? next : current
}

function resolveArtwork(url: string): string {
  if (!url) return ''
  if (url.includes('{w}') || url.includes('{h}')) {
    return resolveAppleMusicArtworkUrl(url, 200, 200)
  }
  return url
}

function SongRow({
  song,
  onSelect,
  onPlay,
}: {
  song: AppleMusicSong
  onSelect: (song: AppleMusicSong) => void
  onPlay: (song: AppleMusicSong) => void
}) {
  const artwork = resolveArtwork(song.artworkUrl)

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="w-10 h-10 rounded overflow-hidden bg-muted flex items-center justify-center">
          {artwork ? (
            <img
              src={artwork}
              alt={song.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <Music2 className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{song.title}</p>
          <p className="text-xs text-muted-foreground truncate">
            {song.artistName} • {song.albumName}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="outline" onClick={() => onSelect(song)}>
          Select
        </Button>
        <Button size="sm" onClick={() => onPlay(song)}>
          <Play className="w-4 h-4 mr-1" />
          Play
        </Button>
      </div>
    </div>
  )
}

function CollectionCard({
  title,
  subtitle,
  artworkUrl,
  onOpen,
}: {
  title: string
  subtitle: string
  artworkUrl: string
  onOpen: () => void
}) {
  const artwork = resolveArtwork(artworkUrl)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 rounded-md border p-2 text-left hover:bg-muted/40 transition-colors"
    >
      <div className="w-12 h-12 rounded overflow-hidden bg-muted flex items-center justify-center">
        {artwork ? (
          <img src={artwork} alt={title} className="w-full h-full object-cover" />
        ) : (
          <Music2 className="w-4 h-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
      </div>
    </button>
  )
}

export default function AppleMusicPage() {
  const { setSongList } = usePlayerActions()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AppleMusicSearchResult>({
    songs: [],
    albums: [],
    playlists: [],
  })
  const [activeAlbum, setActiveAlbum] = useState<AppleMusicAlbum | null>(null)
  const [activePlaylist, setActivePlaylist] = useState<AppleMusicPlaylist | null>(
    null,
  )
  const [selectedTrack, setSelectedTrack] = useState<MediaTrack | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isLoadingAlbum, setIsLoadingAlbum] = useState(false)
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false)
  const [library, setLibrary] = useState<AppleMusicLibraryResult>(
    EMPTY_LIBRARY_RESULT,
  )
  const [libraryNextOffset, setLibraryNextOffset] = useState<number | null>(0)
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false)
  const [hasLoadedLibrary, setHasLoadedLibrary] = useState(false)
  const [browse, setBrowse] = useState<AppleMusicBrowseResult>(EMPTY_BROWSE_RESULT)
  const [isLoadingBrowse, setIsLoadingBrowse] = useState(false)
  const [hasLoadedBrowse, setHasLoadedBrowse] = useState(false)

  const detailSongs = useMemo(() => {
    if (activeAlbum) return activeAlbum.songs
    if (activePlaylist) return activePlaylist.songs
    return []
  }, [activeAlbum, activePlaylist])

  async function ensureInitialized() {
    if (appleMusicService.isAuthorized()) return

    await appleMusicService.initialize()
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const keyword = query.trim()
    if (keyword.length === 0) return

    setIsSearching(true)
    try {
      await ensureInitialized()
      const next = await appleMusicService.search(keyword, [
        'songs',
        'albums',
        'playlists',
      ])
      setResults(next)
      setActiveAlbum(null)
      setActivePlaylist(null)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Apple Music 検索に失敗: ${reason}`)
    } finally {
      setIsSearching(false)
    }
  }

  async function handleOpenAlbum(id: string) {
    setIsLoadingAlbum(true)
    try {
      await ensureInitialized()
      const album = await appleMusicService.getCatalogAlbum(id)
      setActiveAlbum(album)
      setActivePlaylist(null)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`アルバム取得に失敗: ${reason}`)
    } finally {
      setIsLoadingAlbum(false)
    }
  }

  async function handleOpenPlaylist(id: string) {
    setIsLoadingPlaylist(true)
    try {
      await ensureInitialized()
      const playlist = await appleMusicService.getCatalogPlaylist(id)
      setActivePlaylist(playlist)
      setActiveAlbum(null)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`プレイリスト取得に失敗: ${reason}`)
    } finally {
      setIsLoadingPlaylist(false)
    }
  }

  async function handleLoadLibrary(options: {
    reset: boolean
  }) {
    if (isLoadingLibrary) return

    setIsLoadingLibrary(true)
    try {
      await ensureInitialized()
      const offset = options.reset ? 0 : (libraryNextOffset ?? 0)
      const page = await appleMusicService.getLibraryPage({
        limit: 25,
        offset,
      })

      setLibrary((current) => {
        if (options.reset) {
          return {
            songs: page.songs,
            albums: page.albums,
            playlists: page.playlists,
          }
        }

        return {
          songs: appendUniqueById(current.songs, page.songs),
          albums: appendUniqueById(current.albums, page.albums),
          playlists: appendUniqueById(current.playlists, page.playlists),
        }
      })
      setLibraryNextOffset(page.nextOffset)
      setHasLoadedLibrary(true)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`My Library 取得に失敗: ${reason}`)
    } finally {
      setIsLoadingLibrary(false)
    }
  }

  async function handleLoadBrowse() {
    if (isLoadingBrowse) return

    setIsLoadingBrowse(true)
    try {
      await ensureInitialized()
      const next = await appleMusicService.getBrowse({
        newReleasesLimit: 12,
        topChartsLimit: 10,
      })
      setBrowse((current) => ({
        newReleases: keepPreviousWhenEmpty(current.newReleases, next.newReleases),
        topSongs: keepPreviousWhenEmpty(current.topSongs, next.topSongs),
        topAlbums: keepPreviousWhenEmpty(current.topAlbums, next.topAlbums),
        topPlaylists: keepPreviousWhenEmpty(current.topPlaylists, next.topPlaylists),
      }))
      setHasLoadedBrowse(true)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Browse 取得に失敗: ${reason}`)
    } finally {
      setIsLoadingBrowse(false)
    }
  }

  function handleSelect(song: AppleMusicSong) {
    const track = mapAppleMusicSongToMediaTrack(song)
    setSelectedTrack(track)
    toast.success(`選曲: ${track.title} (adamId: ${track.adamId})`)
  }

  function handlePlay(song: AppleMusicSong) {
    const track = mapAppleMusicSongToMediaTrack(song)
    setSelectedTrack(track)
    setSongList([mapAppleMusicSongToAppSong(song)], 0)
  }

  return (
    <div className="w-full max-w-6xl mx-auto p-4 space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Apple Music</h1>
        <p className="text-sm text-muted-foreground">
          検索ファースト + My Library 遅延読み込み + Browse のプロトタイプです。
        </p>
      </div>

      <section className="space-y-3 rounded-md border p-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Search</h2>
          <p className="text-xs text-muted-foreground">
            楽曲/アルバム/プレイリストを横断検索します。
          </p>
        </div>

        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search songs, albums, playlists..."
          />
          <Button type="submit" disabled={isSearching}>
            {isSearching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </Button>
        </form>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Songs</h3>
          <div className="space-y-2">
            {results.songs.length === 0 ? (
              <p className="text-sm text-muted-foreground">検索結果がありません。</p>
            ) : (
              results.songs.map((song) => (
                <SongRow
                  key={`${song.id}-${song.adamId}`}
                  song={song}
                  onSelect={handleSelect}
                  onPlay={handlePlay}
                />
              ))
            )}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Albums</h3>
            <div className="space-y-2">
              {results.albums.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  表示できるアルバムがありません。
                </p>
              ) : (
                results.albums.map((album) => (
                  <CollectionCard
                    key={album.id}
                    title={album.name}
                    subtitle={album.artistName}
                    artworkUrl={album.artworkUrl}
                    onOpen={() =>
                      handleOpenAlbum(resolveAppleMusicAlbumDetailId(album))
                    }
                  />
                ))
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Playlists</h3>
            <div className="space-y-2">
              {results.playlists.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  表示できるプレイリストがありません。
                </p>
              ) : (
                results.playlists.map((playlist) => (
                  <CollectionCard
                    key={playlist.id}
                    title={playlist.name}
                    subtitle={playlist.curatorName ?? 'Apple Music'}
                    artworkUrl={playlist.artworkUrl}
                    onOpen={() => handleOpenPlaylist(playlist.id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">My Library</h2>
            <p className="text-xs text-muted-foreground">
              25件ずつ遅延読み込みします。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleLoadLibrary({ reset: true })}
              disabled={isLoadingLibrary}
            >
              {isLoadingLibrary ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Loading...
                </>
              ) : (
                'Load My Library'
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => handleLoadLibrary({ reset: false })}
              disabled={isLoadingLibrary || !hasLoadedLibrary || libraryNextOffset === null}
            >
              Load More
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Songs: {library.songs.length} / Albums: {library.albums.length} /
          Playlists: {library.playlists.length} / nextOffset:{' '}
          {libraryNextOffset ?? 'none'}
        </p>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Library Songs</h3>
          <div className="space-y-2">
            {library.songs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                まだ取得されていません。
              </p>
            ) : (
              library.songs.map((song) => (
                <SongRow
                  key={`library-song-${song.id}-${song.adamId}`}
                  song={song}
                  onSelect={handleSelect}
                  onPlay={handlePlay}
                />
              ))
            )}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Library Albums</h3>
            <div className="space-y-2">
              {library.albums.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  まだ取得されていません。
                </p>
              ) : (
                library.albums.map((album) => (
                  <CollectionCard
                    key={`library-album-${album.id}`}
                    title={album.name}
                    subtitle={album.artistName}
                    artworkUrl={album.artworkUrl}
                    onOpen={() =>
                      handleOpenAlbum(resolveAppleMusicAlbumDetailId(album))
                    }
                  />
                ))
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Library Playlists</h3>
            <div className="space-y-2">
              {library.playlists.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  まだ取得されていません。
                </p>
              ) : (
                library.playlists.map((playlist) => (
                  <CollectionCard
                    key={`library-playlist-${playlist.id}`}
                    title={playlist.name}
                    subtitle={playlist.curatorName ?? 'Apple Music'}
                    artworkUrl={playlist.artworkUrl}
                    onOpen={() => handleOpenPlaylist(playlist.id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Browse</h2>
            <p className="text-xs text-muted-foreground">
              New Releases と Top Charts を取得します。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleLoadBrowse}
            disabled={isLoadingBrowse}
          >
            {isLoadingBrowse ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              'Load Browse'
            )}
          </Button>
        </div>

        {!hasLoadedBrowse && (
          <p className="text-sm text-muted-foreground">
            まだ取得されていません。
          </p>
        )}

        {hasLoadedBrowse && (
          <>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">
                New Releases ({browse.newReleases.length})
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {browse.newReleases.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    表示できるリリースがありません。
                  </p>
                ) : (
                  browse.newReleases.map((album) => (
                    <CollectionCard
                      key={`browse-new-release-${album.id}`}
                      title={album.name}
                      subtitle={album.artistName}
                      artworkUrl={album.artworkUrl}
                      onOpen={() =>
                        handleOpenAlbum(resolveAppleMusicAlbumDetailId(album))
                      }
                    />
                  ))
                )}
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Top Songs ({browse.topSongs.length})</h3>
              <div className="space-y-2">
                {browse.topSongs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    表示できる楽曲がありません。
                  </p>
                ) : (
                  browse.topSongs.map((song) => (
                    <SongRow
                      key={`browse-top-song-${song.id}-${song.adamId}`}
                      song={song}
                      onSelect={handleSelect}
                      onPlay={handlePlay}
                    />
                  ))
                )}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">
                  Top Albums ({browse.topAlbums.length})
                </h3>
                <div className="space-y-2">
                  {browse.topAlbums.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      表示できるアルバムがありません。
                    </p>
                  ) : (
                    browse.topAlbums.map((album) => (
                      <CollectionCard
                        key={`browse-top-album-${album.id}`}
                        title={album.name}
                        subtitle={album.artistName}
                        artworkUrl={album.artworkUrl}
                        onOpen={() =>
                          handleOpenAlbum(resolveAppleMusicAlbumDetailId(album))
                        }
                      />
                    ))
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">
                  Top Playlists ({browse.topPlaylists.length})
                </h3>
                <div className="space-y-2">
                  {browse.topPlaylists.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      表示できるプレイリストがありません。
                    </p>
                  ) : (
                    browse.topPlaylists.map((playlist) => (
                      <CollectionCard
                        key={`browse-top-playlist-${playlist.id}`}
                        title={playlist.name}
                        subtitle={playlist.curatorName ?? 'Apple Music'}
                        artworkUrl={playlist.artworkUrl}
                        onOpen={() => handleOpenPlaylist(playlist.id)}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          {activeAlbum
            ? `Album: ${activeAlbum.name}`
            : activePlaylist
              ? `Playlist: ${activePlaylist.name}`
              : 'Detail'}
        </h2>
        {(isLoadingAlbum || isLoadingPlaylist) && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            読み込み中...
          </p>
        )}
        {!isLoadingAlbum && !isLoadingPlaylist && detailSongs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            アルバムまたはプレイリストを選択してください。
          </p>
        )}
        {!isLoadingAlbum &&
          !isLoadingPlaylist &&
          detailSongs.map((song) => (
            <SongRow
              key={`detail-${song.id}-${song.adamId}`}
              song={song}
              onSelect={handleSelect}
              onPlay={handlePlay}
            />
          ))}
      </section>

      {selectedTrack && (
        <section className="rounded-md border p-3 bg-muted/25">
          <h2 className="text-sm font-semibold">Selected MediaTrack</h2>
          <p className="text-sm">
            {selectedTrack.title} / adamId: {selectedTrack.adamId}
          </p>
          <p className="text-xs text-muted-foreground">
            source: {selectedTrack.source}, backend: {selectedTrack.playbackBackend},
            sourceId: {selectedTrack.sourceId}
          </p>
        </section>
      )}
    </div>
  )
}
