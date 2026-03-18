import { useQuery } from '@tanstack/react-query'
import { isLocalArtistId } from '@/local-library'
import {
  ArtistSource,
  getArtistById,
  getArtistInfoById,
  getArtists,
  getArtistTopSongsById,
} from '@/queries/artists'
import { queryKeys } from '@/utils/queryKeys'

export const useGetArtists = (source: ArtistSource = 'all') => {
  return useQuery({
    queryKey: [queryKeys.artist.all, source],
    queryFn: () => getArtists(source),
  })
}

export const useGetArtist = (artistId: string) => {
  return useQuery({
    queryKey: [queryKeys.artist.single, artistId],
    queryFn: () => getArtistById(artistId),
    enabled: !!artistId,
  })
}

export const useGetArtistInfo = (artistId: string) => {
  const isLocalArtist = isLocalArtistId(artistId)

  return useQuery({
    queryKey: [queryKeys.artist.info, artistId],
    queryFn: () => getArtistInfoById(artistId),
    enabled: !!artistId && !isLocalArtist,
  })
}

export const useGetTopSongs = (artistId?: string) => {
  return useQuery({
    queryKey: [queryKeys.artist.topSongs, artistId],
    queryFn: () => getArtistTopSongsById(artistId ?? ''),
    enabled: !!artistId,
  })
}
