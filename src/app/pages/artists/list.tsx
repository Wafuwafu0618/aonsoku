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
import { useAppArtistsViewType } from '@/store/app.store'
import { usePlayerActions } from '@/store/player.store'
import { ISimilarArtist } from '@/types/responses/artist'
import { AlbumsSearchParams, SourceFilter, SourceFilters } from '@/utils/albumsFilter'
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

  const columns = artistsColumns()

  const { data: artists, isLoading } = useGetArtists(sourceFilter)

  async function handlePlayArtistRadio(artist: ISimilarArtist) {
    const songList = await getArtistAllSongs(artist.id)

    if (songList) setSongList(songList, 0)
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
