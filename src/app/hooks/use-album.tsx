import { useQuery } from '@tanstack/react-query'
import { isLocalAlbumId } from '@/local-library'
import { getAlbumById } from '@/queries/albums'
import { subsonic } from '@/service/subsonic'
import { queryKeys } from '@/utils/queryKeys'

export const useGetAlbum = (albumId: string) => {
  return useQuery({
    queryKey: [queryKeys.album.single, albumId],
    queryFn: () => getAlbumById(albumId),
  })
}

export const useGetAlbumInfo = (albumId: string) => {
  const isLocalAlbum = isLocalAlbumId(albumId)

  return useQuery({
    queryKey: [queryKeys.album.info, albumId],
    queryFn: () => subsonic.albums.getInfo(albumId),
    enabled: !!albumId && !isLocalAlbum,
  })
}

export const useGetArtistAlbums = (artistId: string) => {
  const isLocalArtist = artistId.startsWith('local-artist:')

  return useQuery({
    queryKey: [queryKeys.album.moreAlbums, artistId],
    queryFn: () => subsonic.artists.getOne(artistId),
    enabled: !!artistId && !isLocalArtist,
  })
}

export const useGetGenreAlbums = (genre: string) => {
  return useQuery({
    queryKey: [queryKeys.album.genreAlbums, genre],
    queryFn: () =>
      subsonic.albums.getAlbumList({
        type: 'byGenre',
        genre,
        size: 16,
      }),
    enabled: !!genre,
  })
}
