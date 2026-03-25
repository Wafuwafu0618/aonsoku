import { AppleMusicFavoriteGenrePicks } from '@/app/components/home/apple-music-favorite-picks'
import {
  AppleMusicGenreRecommendations,
  AppleMusicPersonalMixes,
} from '@/app/components/home/apple-music-personalized'
import {
  AppleMusicBrowsePlaylists,
  AppleMusicRecentlyAdded,
  AppleMusicTopCharts,
} from '@/app/components/home/apple-music-sections'
import { Explore } from '@/app/components/home/explore'
import { GenreRecommendations } from '@/app/components/home/genre-recommendations'
import { PersonalMixes } from '@/app/components/home/personal-mixes'
import { RecentlyAdded } from '@/app/components/home/recently-added'
import { RecentlyPlayed } from '@/app/components/home/recently-played'
import { TopMostPlayedGrid } from '@/app/components/home/top-most-played-grid'
import {
  useGetAppleMusicBrowse,
  useGetAppleMusicLibraryPage,
} from '@/app/hooks/use-apple-music'
import { useMediaLibraryMode } from '@/store/app.store'

export default function Home() {
  const { mode } = useMediaLibraryMode()

  return (
    <div className="w-full">
      {mode === 'navidrome' ? (
        <>
          <TopMostPlayedGrid />
          <div className="px-8 pb-6">
            <RecentlyPlayed />
            <RecentlyAdded />
            <GenreRecommendations />
            <Explore />
            <PersonalMixes />
          </div>
        </>
      ) : (
        <AppleMusicHome />
      )}
    </div>
  )
}

function AppleMusicHome() {
  const { data: browseData, isLoading: isBrowseLoading } =
    useGetAppleMusicBrowse({
      newReleasesLimit: 12,
      topChartsLimit: 10,
    })
  const { data: libraryData, isLoading: isLibraryLoading } =
    useGetAppleMusicLibraryPage({
      limit: 25,
      offset: 0,
    })

  const isLoading = isBrowseLoading || isLibraryLoading

  if (isLoading) {
    return <AppleMusicHomeFallback />
  }

  return (
    <>
      <AppleMusicFavoriteGenrePicks />
      <div className="px-8 pb-6">
        <AppleMusicGenreRecommendations songs={libraryData?.songs} />
        <AppleMusicPersonalMixes
          songs={libraryData?.songs}
          albums={libraryData?.albums}
        />
        <AppleMusicTopCharts
          songs={browseData?.topSongs}
          albums={browseData?.topAlbums}
          playlists={browseData?.topPlaylists}
        />
        <AppleMusicRecentlyAdded albums={libraryData?.albums} />
        <AppleMusicBrowsePlaylists playlists={browseData?.topPlaylists} />
      </div>
    </>
  )
}

function AppleMusicHomeFallback() {
  return (
    <>
      <section className="px-8 pt-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-[72px] rounded-lg bg-skeleton" />
          ))}
        </div>
      </section>
      <div className="px-8 pb-6">
        <div className="w-full flex flex-col mt-4">
          <div className="my-4 h-8 w-48 bg-skeleton rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <div className="aspect-square bg-skeleton rounded-md" />
                <div className="h-4 bg-skeleton rounded w-3/4" />
                <div className="h-3 bg-skeleton rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
        <div className="w-full flex flex-col mt-4">
          <div className="my-4 h-8 w-48 bg-skeleton rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <div className="aspect-square bg-skeleton rounded-md" />
                <div className="h-4 bg-skeleton rounded w-3/4" />
                <div className="h-3 bg-skeleton rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
