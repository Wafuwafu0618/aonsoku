import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'react-toastify'
import { ShadowHeader } from '@/app/components/album/shadow-header'
import { InfinitySongListFallback } from '@/app/components/fallbacks/song-fallbacks'
import { HeaderTitle } from '@/app/components/header-title'
import { ClearFilterButton } from '@/app/components/search/clear-filter-button'
import { ExpandableSearchInput } from '@/app/components/search/expandable-input'
import { SourceFilterComponent } from '@/app/components/search/source-filter'
import { DataTableList } from '@/app/components/ui/data-table-list'
import { useGetAppleMusicLibraryPage } from '@/app/hooks/use-apple-music'
import { useTotalSongs } from '@/app/hooks/use-total-songs'
import { songsColumns } from '@/app/tables/songs-columns'
import { getArtistAllSongs, songsSearch } from '@/queries/songs'
import { useMediaLibraryMode } from '@/store/app.store'
import { usePlayerActions } from '@/store/player.store'
import { ColumnFilter } from '@/types/columnFilter'
import { AppleMusicSong } from '@/types/responses/apple-music'
import {
  AlbumsFilters,
  AlbumsSearchParams,
  LibraryScopeFilter,
  LibraryScopeFilters,
  SongSourceFilter,
  SongSourceFilters,
  songSourceFilterValues,
} from '@/utils/albumsFilter'
import { queryKeys } from '@/utils/queryKeys'
import { SearchParamsHandler } from '@/utils/searchParamsHandler'

const DEFAULT_OFFSET = 100

export default function SongList() {
  const { t } = useTranslation()
  const { setSongList } = usePlayerActions()
  const [searchParams] = useSearchParams()
  const { getSearchParam } = new SearchParamsHandler(searchParams)
  const { mode } = useMediaLibraryMode()
  const columns = songsColumns()

  const filter = getSearchParam<string>(AlbumsSearchParams.MainFilter, '')
  const query = getSearchParam<string>(AlbumsSearchParams.Query, '')
  const artistId = getSearchParam<string>(AlbumsSearchParams.ArtistId, '')
  const artistName = getSearchParam<string>(AlbumsSearchParams.ArtistName, '')
  const sourceFilter = getSearchParam<SongSourceFilter>(
    AlbumsSearchParams.Source,
    SongSourceFilters.All,
  )
  const libraryScope = getSearchParam<LibraryScopeFilter>(
    AlbumsSearchParams.Scope,
    LibraryScopeFilters.All,
  )
  const favoritesOnly = libraryScope === LibraryScopeFilters.Favorites

  const searchFilterIsSet = filter === AlbumsFilters.Search && query !== ''
  const filterByArtist = artistId !== '' && artistName !== ''
  const sourceFilterIsSet = sourceFilter !== SongSourceFilters.All
  const hasSomeFilter =
    searchFilterIsSet || filterByArtist || sourceFilterIsSet || favoritesOnly

  async function fetchSongs({ pageParam = 0 }) {
    if (filterByArtist) {
      return getArtistAllSongs(artistId)
    }

    return songsSearch({
      query: searchFilterIsSet ? query : '',
      songCount: DEFAULT_OFFSET,
      songOffset: pageParam,
      source: sourceFilter,
      favoritesOnly,
    })
  }

  const {
    data,
    isLoading,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    isError,
    error,
  } = useInfiniteQuery({
    queryKey: [
      queryKeys.song.all,
      filter,
      query,
      artistId,
      sourceFilter,
      libraryScope,
    ],
    initialPageParam: 0,
    queryFn: fetchSongs,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
    enabled: mode === 'navidrome',
  })

  useEffect(() => {
    if (!isError || !error) return

    const message = error instanceof Error ? error.message : String(error)
    toast.error(message)
  }, [error, isError])

  const { data: songCountData, isLoading: songCountIsLoading } = useTotalSongs()

  if (mode === 'applemusic') {
    return <AppleMusicSongList />
  }

  if (isLoading && !isFetchingNextPage) {
    return <InfinitySongListFallback />
  }
  if (!data) return null

  const songlist = data.pages.flatMap((page) => page.songs) ?? []
  const totalCountFromQuery = data.pages[0]?.totalCount
  const songCount =
    (hasSomeFilter
      ? (totalCountFromQuery ?? songlist.length)
      : songCountData) ?? 0

  function handlePlaySong(index: number) {
    if (songlist) setSongList(songlist, index)
  }

  const columnsToShow: ColumnFilter[] = [
    'index',
    'title',
    // 'artist',
    'album',
    'duration',
    'playCount',
    'played',
    'contentType',
    'select',
  ]

  const title = filterByArtist
    ? t('songs.list.byArtist', { artist: artistName })
    : t('sidebar.songs')

  return (
    <div className="w-full h-content">
      <ShadowHeader
        showGlassEffect={false}
        fixed={false}
        className="relative w-full justify-between items-center"
      >
        <HeaderTitle
          title={title}
          count={songCount}
          loading={songCountIsLoading}
        />

        <div className="flex gap-2 flex-1 justify-end">
          {filterByArtist && <ClearFilterButton />}
          <SourceFilterComponent
            options={songSourceFilterValues}
            defaultFilter={SongSourceFilters.All}
          />
          <ExpandableSearchInput
            placeholder={t('songs.list.search.placeholder')}
          />
        </div>
      </ShadowHeader>

      <div className="w-full h-[calc(100%-80px)] overflow-auto">
        <DataTableList
          columns={columns}
          data={songlist}
          handlePlaySong={(row) => handlePlaySong(row.index)}
          columnFilter={columnsToShow}
          fetchNextPage={fetchNextPage}
          hasNextPage={hasNextPage}
        />
      </div>
    </div>
  )
}

function AppleMusicSongList() {
  const { t } = useTranslation()
  const { setSongList } = usePlayerActions()
  const columns = songsColumns()
  const { data: libraryData, isLoading } = useGetAppleMusicLibraryPage({
    limit: 100,
    offset: 0,
  })

  const songs = libraryData?.songs ?? []
  const songCount = songs.length

  function handlePlaySong(index: number) {
    if (songs.length > 0) {
      // Apple Music songs need to be mapped to the app's song format
      const mappedSongs = songs.map(mapAppleMusicSongToAppSong)
      setSongList(mappedSongs, index)
    }
  }

  const columnsToShow: ColumnFilter[] = [
    'index',
    'title',
    'album',
    'duration',
    'contentType',
  ]

  // Map Apple Music songs to app song format for display
  const displaySongs = songs.map(mapAppleMusicSongToAppSong)

  if (isLoading) {
    return <InfinitySongListFallback />
  }

  return (
    <div className="w-full h-content">
      <ShadowHeader
        showGlassEffect={false}
        fixed={false}
        className="relative w-full justify-between items-center"
      >
        <HeaderTitle
          title={t('sidebar.songs')}
          count={songCount}
          loading={false}
        />

        <div className="flex gap-2 flex-1 justify-end">
          <ExpandableSearchInput
            placeholder={t('songs.list.search.placeholder')}
          />
        </div>
      </ShadowHeader>

      <div className="w-full h-[calc(100%-80px)] overflow-auto">
        <DataTableList
          columns={columns}
          data={displaySongs}
          handlePlaySong={(row) => handlePlaySong(row.index)}
          columnFilter={columnsToShow}
          fetchNextPage={() => {}}
          hasNextPage={false}
        />
      </div>
    </div>
  )
}

// Helper function to map Apple Music song to app song format
function mapAppleMusicSongToAppSong(song: AppleMusicSong): any {
  return {
    id: song.id,
    title: song.title,
    artist: song.artistName,
    album: song.albumName,
    albumId: '', // Not available from Apple Music library API
    artistId: '', // Not available from Apple Music library API
    duration: Math.floor(song.durationMs / 1000),
    coverArt: song.artworkUrl || '',
    path: `apple-music://${song.adamId || song.id}`,
    track: song.trackNumber || 1,
    discNumber: song.discNumber || 1,
    year: 0,
    genre: song.genreNames?.[0] || '',
    contentType: 'audio/mpeg',
  }
}
