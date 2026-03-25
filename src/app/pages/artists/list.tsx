import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { ShadowHeader } from '@/app/components/album/shadow-header'
import { ArtistGridCard } from '@/app/components/artist/artist-grid-card'
import { ArtistsFallback } from '@/app/components/fallbacks/artists.tsx'
import { GridViewWrapper } from '@/app/components/grid-view-wrapper'
import { HeaderTitle } from '@/app/components/header-title'
import ListWrapper from '@/app/components/list-wrapper'
import { MainViewTypeSelector } from '@/app/components/main-grid'
import { SourceFilterComponent } from '@/app/components/search/source-filter'
import { DataTable } from '@/app/components/ui/data-table'
import { useGetArtists } from '@/app/hooks/use-artist'
import { useSongList } from '@/app/hooks/use-song-list'
import { artistsColumns } from '@/app/tables/artists-columns'
import { useAppArtistsViewType, useMediaLibraryMode } from '@/store/app.store'
import { usePlayerActions } from '@/store/player.store'
import { ISimilarArtist } from '@/types/responses/artist'
import {
  AlbumsSearchParams,
  LibraryScopeFilter,
  LibraryScopeFilters,
  SourceFilter,
  SourceFilters,
} from '@/utils/albumsFilter'
import { SearchParamsHandler } from '@/utils/searchParamsHandler'

const MemoShadowHeader = memo(ShadowHeader)
const MemoHeaderTitle = memo(HeaderTitle)
const MemoViewTypeSelector = memo(MainViewTypeSelector)
const MemoDataTable = memo(DataTable) as typeof DataTable
const MemoListWrapper = memo(ListWrapper)

export default function ArtistsList() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const { getSearchParam } = new SearchParamsHandler(searchParams)
  const { getArtistAllSongs } = useSongList()
  const { setSongList } = usePlayerActions()
  const { mode } = useMediaLibraryMode()
  const {
    artistsPageViewType,
    setArtistsPageViewType,
    isTableView,
    isGridView,
  } = useAppArtistsViewType()
  const sourceFilter = getSearchParam<SourceFilter>(
    AlbumsSearchParams.Source,
    SourceFilters.All,
  )
  const libraryScope = getSearchParam<LibraryScopeFilter>(
    AlbumsSearchParams.Scope,
    LibraryScopeFilters.All,
  )
  const favoritesOnly = libraryScope === LibraryScopeFilters.Favorites

  const columns = artistsColumns()

  const { data: artists, isLoading } = useGetArtists(sourceFilter, {
    favoritesOnly,
  })

  async function handlePlayArtistRadio(artist: ISimilarArtist) {
    const songList = await getArtistAllSongs(artist.id)

    if (songList) setSongList(songList, 0)
  }

  if (mode === 'applemusic') {
    return <AppleMusicArtistsPlaceholder />
  }

  if (isLoading) return <ArtistsFallback />
  if (!artists) return null

  return (
    <div className="w-full h-full">
      <MemoShadowHeader className="flex justify-between">
        <MemoHeaderTitle title={t('sidebar.artists')} count={artists.length} />

        <div className="flex items-center gap-2">
          <SourceFilterComponent />

          <MemoViewTypeSelector
            viewType={artistsPageViewType}
            setViewType={setArtistsPageViewType}
          />
        </div>
      </MemoShadowHeader>

      {isTableView && (
        <MemoListWrapper>
          <MemoDataTable
            columns={columns}
            data={artists}
            showPagination={true}
            showSearch={true}
            searchColumn="name"
            handlePlaySong={(row) => handlePlayArtistRadio(row.original)}
            allowRowSelection={false}
            dataType="artist"
          />
        </MemoListWrapper>
      )}

      {isGridView && (
        <MemoListWrapper className="px-0">
          <GridViewWrapper
            list={artists}
            data-testid="artists-grid"
            type="artists"
          >
            {(artist) => <ArtistGridCard artist={artist} />}
          </GridViewWrapper>
        </MemoListWrapper>
      )}
    </div>
  )
}

function AppleMusicArtistsPlaceholder() {
  const { t } = useTranslation()

  return (
    <div className="w-full h-full">
      <div className="flex justify-between items-center px-8 py-4">
        <div>
          <h1 className="text-2xl font-bold">{t('sidebar.artists')}</h1>
          <p className="text-muted-foreground">0 artists</p>
        </div>
      </div>

      <div className="px-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="aspect-square bg-skeleton rounded-full" />
              <div className="h-4 bg-skeleton rounded w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
