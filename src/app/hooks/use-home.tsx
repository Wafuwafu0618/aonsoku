import { useQuery } from '@tanstack/react-query'
import { subsonic } from '@/service/subsonic'
import { Albums } from '@/types/responses/album'
import { convertMinutesToMs } from '@/utils/convertSecondsToTime'
import { queryKeys } from '@/utils/queryKeys'

const HOME_GENRE_RECOMMENDATION_COUNT = 3
const HOME_GENRE_ALBUM_COUNT = 16

interface HomeGenreRecommendation {
  genre: string
  albums: Albums[]
}

function getRecommendedGenres() {
  return subsonic.genres.get().then((genres) => {
    if (!genres) return []

    return [...genres]
      .filter((genre) => genre.value.trim() !== '' && genre.albumCount > 0)
      .sort((a, b) => b.albumCount - a.albumCount)
      .slice(0, HOME_GENRE_RECOMMENDATION_COUNT)
      .map((genre) => genre.value)
  })
}

async function fetchGenreRecommendations(): Promise<HomeGenreRecommendation[]> {
  const genres = await getRecommendedGenres()
  if (genres.length === 0) return []

  const sections = await Promise.all(
    genres.map(async (genre) => {
      const response = await subsonic.albums.getAlbumList({
        type: 'byGenre',
        genre,
        size: HOME_GENRE_ALBUM_COUNT,
      })

      return {
        genre,
        albums: response?.list ?? [],
      }
    }),
  )

  return sections.filter((section) => section.albums.length > 0)
}

export const useGetRandomSongs = () => {
  return useQuery({
    queryKey: [queryKeys.song.random],
    queryFn: () => subsonic.songs.getRandomSongs({ size: 10 }),
  })
}

export const useGetRecentlyAdded = () => {
  return useQuery({
    queryKey: [queryKeys.album.recentlyAdded],
    queryFn: () =>
      subsonic.albums.getAlbumList({
        size: 16,
        type: 'newest',
      }),
  })
}

export const useGetMostPlayed = () => {
  return useQuery({
    queryKey: [queryKeys.album.mostPlayed],
    queryFn: () =>
      subsonic.albums.getAlbumList({
        size: 60,
        type: 'frequent',
      }),
  })
}

export const useGetRecentlyPlayed = () => {
  return useQuery({
    queryKey: [queryKeys.album.recentlyPlayed],
    queryFn: () =>
      subsonic.albums.getAlbumList({
        size: 16,
        type: 'recent',
      }),
    refetchInterval: convertMinutesToMs(2),
  })
}

export const useGetRandomAlbums = () => {
  return useQuery({
    queryKey: [queryKeys.album.random],
    queryFn: () =>
      subsonic.albums.getAlbumList({
        size: 16,
        type: 'random',
      }),
  })
}

export const useGetGenreRecommendations = () => {
  return useQuery({
    queryKey: [queryKeys.album.genreRecommendations],
    queryFn: fetchGenreRecommendations,
    staleTime: convertMinutesToMs(10),
  })
}
