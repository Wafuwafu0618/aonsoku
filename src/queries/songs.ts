import { LocalTrack } from '@/local-library'
import { getAllTracks, searchTracks } from '@/local-library/repository'
import { SearchQueryOptions } from '@/service/search'
import { subsonic } from '@/service/subsonic'
import { ISong } from '@/types/responses/song'

const emptyResponse = { songs: [], nextOffset: null }

type SongSearchParams = Required<
  Pick<SearchQueryOptions, 'query' | 'songCount' | 'songOffset'>
> & {
  source?: 'all' | 'navidrome' | 'local'
}

/**
 * LocalTrackをISong形式に変換（簡易版）
 * TODO: 完全なマッピング実装が必要
 */
function convertLocalTrackToISong(track: LocalTrack): ISong {
  return {
    id: track.id,
    parent: '',
    isDir: false,
    title: track.title,
    album: track.album,
    artist: track.artist,
    track: track.trackNumber ?? 0,
    year: track.year ?? 0,
    genre: track.genre,
    coverArt: track.coverArt || '',
    size: track.fileSize,
    contentType: getContentType(track.format),
    suffix: track.format,
    duration: track.duration,
    bitRate: track.bitrate ?? 0,
    path: track.filePath,
    discNumber: track.discNumber ?? 0,
    type: 'music',
  } as ISong
}

function getContentType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    alac: 'audio/mp4',
  }
  return mimeTypes[format] || 'audio/mpeg'
}

export async function songsSearch(params: SongSearchParams) {
  const { source = 'all', query, songCount, songOffset } = params
  const navidromeSongs: ISong[] = []
  const localSongs: ISong[] = []

  // Navidromeから曲を取得（allまたはnavidromeの場合）
  if (source === 'all' || source === 'navidrome') {
    const response = await subsonic.search.get({
      artistCount: 0,
      albumCount: 0,
      query,
      songCount,
      songOffset,
    })

    if (response?.song) {
      navidromeSongs.push(...response.song)
    }
  }

  // ローカルライブラリから曲を取得（allまたはlocalの場合）
  if (source === 'all' || source === 'local') {
    if (query) {
      const tracks = await searchTracks(query)
      localSongs.push(...tracks.map(convertLocalTrackToISong))
    } else {
      const tracks = await getAllTracks()
      localSongs.push(...tracks.map(convertLocalTrackToISong))
    }
  }

  // 結果をマージ
  let mergedSongs: ISong[] = []

  if (source === 'all') {
    mergedSongs = [...navidromeSongs, ...localSongs]
  } else if (source === 'navidrome') {
    mergedSongs = navidromeSongs
  } else {
    mergedSongs = localSongs
  }

  // オフセットと件数でフィルタリング
  const paginatedSongs = mergedSongs.slice(songOffset, songOffset + songCount)

  let nextOffset: number | null = null
  if (songOffset + songCount < mergedSongs.length) {
    nextOffset = songOffset + songCount
  }

  return {
    songs: paginatedSongs,
    nextOffset,
  }
}

export async function getArtistAllSongs(artistId: string) {
  const artist = await subsonic.artists.getOne(artistId)

  if (!artist || !artist.album) return emptyResponse

  const results = await Promise.all(
    artist.album.map(({ id }) => subsonic.albums.getOne(id)),
  )

  const songs = results.flatMap((result) => {
    if (!result) return []

    return result.song
  })

  return {
    songs,
    nextOffset: null,
  }
}

export async function getFavoriteSongs() {
  const response = await subsonic.songs.getFavoriteSongs()

  if (!response || !response.song) return { songs: [] }

  return { songs: response.song }
}
