import { useTranslation } from 'react-i18next'
import { AlbumGridCard } from '@/app/components/albums/album-grid-card'
import { EmptyAlbums } from '@/app/components/albums/empty-page'
import { AlbumsHeader } from '@/app/components/albums/header'
import { AlbumsFallback } from '@/app/components/fallbacks/album-fallbacks'
import { GridViewWrapper } from '@/app/components/grid-view-wrapper'
import ListWrapper from '@/app/components/list-wrapper'
import { useGetAppleMusicLibraryPage } from '@/app/hooks/use-apple-music'
import { resolveAppleMusicAlbumDetailId } from '@/domain/mappers/apple-music'
import { useMediaLibraryMode } from '@/store/app.store'
import { AppleMusicAlbum } from '@/types/responses/apple-music'
import { useAlbumsListModel } from './list.model'

export default function AlbumsList() {
  const { isLoading, isEmpty, albums, albumsCount } = useAlbumsListModel()
  const { mode } = useMediaLibraryMode()

  if (mode === 'applemusic') {
    return <AppleMusicAlbumsList />
  }

  if (isLoading) return <AlbumsFallback />
  if (isEmpty) return <EmptyAlbums />

  return (
    <div className="w-full h-full">
      <AlbumsHeader albumCount={albumsCount} />

      <ListWrapper className="px-0">
        <GridViewWrapper list={albums} data-testid="albums-grid" type="albums">
          {(album) => <AlbumGridCard album={album} />}
        </GridViewWrapper>
      </ListWrapper>
    </div>
  )
}

function AppleMusicAlbumsList() {
  const { t } = useTranslation()
  const { data: libraryData, isLoading } = useGetAppleMusicLibraryPage({
    limit: 100,
    offset: 0,
  })

  const albums = libraryData?.albums ?? []
  const albumsCount = albums.length

  // Map Apple Music albums to app album format
  const displayAlbums = albums.map(mapAppleMusicAlbumToAppAlbum)

  if (isLoading) {
    return (
      <div className="w-full h-full">
        <div className="flex justify-between items-center px-8 py-4">
          <div>
            <h1 className="text-2xl font-bold">{t('sidebar.albums')}</h1>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
        <div className="px-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <div className="aspect-square bg-skeleton rounded-md" />
                <div className="h-4 bg-skeleton rounded w-3/4" />
                <div className="h-3 bg-skeleton rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (albumsCount === 0) {
    return <EmptyAlbums />
  }

  return (
    <div className="w-full h-full">
      <div className="flex justify-between items-center px-8 py-4">
        <div>
          <h1 className="text-2xl font-bold">{t('sidebar.albums')}</h1>
          <p className="text-muted-foreground">{albumsCount} albums</p>
        </div>
      </div>

      <ListWrapper className="px-0">
        <GridViewWrapper
          list={displayAlbums}
          data-testid="albums-grid"
          type="albums"
        >
          {(album) => <AlbumGridCard album={album} />}
        </GridViewWrapper>
      </ListWrapper>
    </div>
  )
}

// Helper function to map Apple Music album to app album format
function mapAppleMusicAlbumToAppAlbum(album: AppleMusicAlbum): any {
  const detailId = resolveAppleMusicAlbumDetailId(album)

  return {
    id: `apple-music:${detailId}`,
    name: album.name,
    artist: album.artistName,
    artistId: undefined,
    coverArt: album.artworkUrl || '',
    songCount: album.trackCount || 0,
    year: album.releaseDate ? new Date(album.releaseDate).getFullYear() : 0,
    genre: '', // Not directly available
  }
}
