import { getAlbumById } from '@/queries/albums'
import { getArtistAllSongs as getArtistAllSongsQuery } from '@/queries/songs'
import { subsonic } from '@/service/subsonic'

export function useSongList() {
  async function getArtistSongCount(id: string) {
    if (id.startsWith('local-artist:')) {
      const response = await getArtistAllSongsQuery(id)
      return response.totalCount ?? response.songs.length
    }

    const response = await subsonic.artists.getOne(id)
    let count = 0

    if (!response || !response.album) return count

    response.album.forEach((item) => {
      count += item.songCount
    })

    return count
  }

  async function getArtistAllSongs(artistIdOrName: string) {
    const response = await getArtistAllSongsQuery(artistIdOrName)
    return response.songs
  }

  async function getAlbumSongs(albumId: string) {
    const songs = await getAlbumById(albumId)

    if (!songs || !songs.song) return undefined

    return songs.song
  }

  return {
    getArtistSongCount,
    getArtistAllSongs,
    getAlbumSongs,
  }
}
